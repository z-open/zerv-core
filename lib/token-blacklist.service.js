const _ = require('lodash');
const moment = require('moment');
const zlog = require('zimit-zlog');
const cacheService = require('./cache.service');

const logger = zlog.getLogger('zerv/core/tokenBlackList');

let blackList = {}, tokenDisposalInMins;
const REDIS_REVOKED_TOKEN_PREFIX = 'REVOK_TOK_';

const service = {
    revokeToken,
    isTokenRevoked,
    scheduleTokenMaintenance,

    _clearBlackList,
    _removeExpiredTokensFromBlackList
};

module.exports = service;


async function isTokenRevoked(token) {
    if (cacheService.isClusterCacheEnabled()) {
        return await cacheService.getCachedBooleanValue(token, {prefix: REDIS_REVOKED_TOKEN_PREFIX});
    }
    return !_.isNil(blackList[token]);
};
/**
 * Revoke token to prevent re-use
 *
 * when a token is refreshed, the previous token might still be valid for a little time
 * if someone gains access to it, a new session could be started
 * When a user logs out (manually or on session timeout), the token is still valid and could be reused.
 *
 * @param {String} token
 */
async function revokeToken(token) {
    logger.debug('Revoke token %b', token);

    if (cacheService.isClusterCacheEnabled()) {
        // the token will auto expires and be removed from the black list in redis
        await cacheService.cacheData(token, true, {prefix: REDIS_REVOKED_TOKEN_PREFIX, expirationInMins: tokenDisposalInMins});
    } else {
        // Set some disposal date (not accurate but surely greater that the remaining validity time)
        blackList[token] = moment().add(tokenDisposalInMins, 'minutes').toDate();
    }
}

/**
 * Schedule the removal of expired tokens
 * After a token is expired, there is no risk that someone exploits it to gain access.
 * Until then revoked token are tracked.
 *
 * @param {Number} maintenanceIntervalInMins
 * @param {Number} tokenExpiresInMins
 */
function scheduleTokenMaintenance(maintenanceIntervalInMins, tokenExpiresInMins) {
    // add 5% just to make sure there is no security hole.
    tokenDisposalInMins = (tokenExpiresInMins * 105) / 100;

    if (cacheService.isClusterCacheEnabled()) {
        // Token will expire by themselves thanks to redis
        // Token should not be removed until they have expired
        return;
    }
    setInterval(() => {
        logger.info('Start server token maintenance.');
        service._removeExpiredTokensFromBlackList();
    }, (maintenanceIntervalInMins || 5) * 60 * 1000);
}

function _removeExpiredTokensFromBlackList() {
    for (const token in blackList) {
        if (moment().isAfter(blackList[token])) {
            logger.debug('Remove expired token %b from blackList.', token);
            delete blackList[token];
        }
    }
}

function _clearBlackList() {
    // for test purposes
    blackList = {};
};
