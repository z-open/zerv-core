const zlog = require('zimit-zlog');
const cacheService = require('./cache.service');

const logger = zlog.getLogger('zerv/core/tokenBlackList');

const REDIS_REVOKED_TOKEN_PREFIX = 'REVOK_TOK_';

const service = {
    revokeToken,
    isTokenRevoked,
};

module.exports = service;


async function isTokenRevoked(token) {
    return await cacheService.getCachedBooleanValue(token, {prefix: REDIS_REVOKED_TOKEN_PREFIX});
};
/**
 * Revoke token to prevent re-use
 *
 * when a token is refreshed, the previous token might still be valid for a little time
 * if someone gains access to it, a new session could be started
 * When a user logs out (manually or on session timeout), the token is still valid and could be reused.
 *
 * @param {String} token
 * @param {Number} tokenExp coming from the payload exp calculated by jsonwebtoken during token generation
 * @returns {Promise} complete when done.
 */
async function revokeToken(token, tokenExp) {
    const expOn = new Date(tokenExp * 1000);
    let remainingLifeInMins = Math.ceil((expOn.getTime() - Date.now()) / 60000);
    logger.debug('Revoke token %b with remaining life %s mins', token.substr(-10), remainingLifeInMins);
    remainingLifeInMins = remainingLifeInMins < 0 ? 0 : remainingLifeInMins;

    // the token will auto expires and be removed from the black list
    await cacheService.cacheData(token, true, {prefix: REDIS_REVOKED_TOKEN_PREFIX, expirationInMins: remainingLifeInMins});
}
