const { Subscription, SlackUser, GitHubUser } = require('../models');
const { ReEnableSubscription } = require('../messages/flow');
const avoidReplicationLag = require('../github/avoid-replication-lag');
const isPermanentError = require('../slack/is-permanent-error');
const cache = require('../cache');
const logger = require('../logger');
const processor = require('./processor')(logger);

// Temporary "middleware" hack to look up routing before delivering event
module.exports = function route(callback) {
  return async (context) => {
    if (context.payload.repository) {
      const query = [
        { githubId: context.payload.repository.id, type: 'repo' }, // for repository subscriptions
        { githubId: context.payload.repository.owner.id, type: 'account' }, // for account subscriptions
      ];
      const subscriptions = await Subscription.lookupAll(query);

      context.log.debug({ subscriptions }, 'Delivering to subscribed channels');

      const promise = Promise.all(subscriptions.map(async (subscription) => {
        if (!subscription.isEnabledForGitHubEvent(context.event)) {
          return;
        }

        const eventType = `${context.event}.${context.payload.action}`;

        if (eventType === 'repository.deleted' && subscription.type === 'account') {
          // Do not deliver repository.deleted events for org subscriptions
          return;
        }

        // Create clack client with workspace token
        const slack = subscription.SlackWorkspace.client;

        if (subscription.creatorId && eventType !== 'repository.deleted') {
          // Verify that subscription creator still has access to the resource
          const creator = await SlackUser.findById(subscription.creatorId, {
            include: [GitHubUser],
          });

          const cacheKey = `creator-access#${creator.GitHubUser.id}:${context.payload.repository.id}`;
          const hasRepoAccess = await cache.fetch(
            cacheKey,
            () => creator.GitHubUser.hasRepoAccess(context.payload.repository.id),
            10 * 60 * 1000,
          );

          if (!hasRepoAccess) {
            if (subscription.type === 'account') {
              // It is fine to subscribe to an account and not have access to all repos.
              // We just ignore the events for repos the user doesn't have access to.
              return;
            }
            context.log.debug({
              subscription: {
                channelId: subscription.channelId,
                creatorId: subscription.creatorId,
                githubId: subscription.githubId,
                workspaceId: subscription.SlackWorkspace.slackId,
              },
            }, 'User lost access to resource. Deleting subscription.');

            await Promise.all([
              // @todo: deactive this subscription instead of deleting the db record
              await subscription.destroy(),
              await slack.chat.postMessage({
                channel: subscription.channelId,
                ...new ReEnableSubscription(context.payload.repository, creator.slackId).toJSON(),
              }),
            ]);
            return;
          }
        }

        // Delay GitHub API calls to avoid replication lag
        context.github.hook.before('request', avoidReplicationLag());

        // Label filtering
        const issue = context.payload.issue || context.payload.pull_request;
        const shouldFilterByLabel = (() => {
          if (issue === undefined) {
            return false;
          }

          if (!Array.isArray(issue.labels)) {
            return false;
          }

          if (subscription.settings.label === undefined) {
            return false;
          }

          if (!Array.isArray(subscription.settings.label)) {
            return false;
          }

          if (subscription.settings.label.length === 0) {
            return false;
          }

          return true;
        })();
        if (shouldFilterByLabel) {
          const labels = issue.labels.map(l => l.name);
          const whitelist = subscription.settings.label;

          if (!labels.some(l => whitelist.includes(l))) {
            context.log.debug({ issueLabel: labels, whiteList: whitelist }, 'Stop routing due to label filtering');
            return;
          }
        }

        try {
          await callback(context, subscription, slack);
        } catch (err) {
          if (isPermanentError(err)) {
            const { repository } = context.payload;
            const info = {
              err, subscription, eventType, repo: repository.full_name,
            };
            context.log.info(info, 'Permanent error from Slack. Removing subscription');
            await subscription.destroy();
          } else {
            throw err;
          }
        }
      }));

      return processor(promise);
    }
  };
};
