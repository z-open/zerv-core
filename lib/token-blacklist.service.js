const _ = require('lodash');
const moment = require('moment');
const zlog = require('zimit-zlog');
const logger = zlog.getLogger('zerv/core');
const redisService = require('./redis.service');


let blackList = {}, tokenDisposalInMins;

module.exports = {
    blackListToken,
    checkIfTokenRefreshedInSharedDb,
    updateRefreshedTokenInSharedDb,
    scheduleTokenMaintenance,
    clearBlackList
};


async function checkIfTokenRefreshedInSharedDb(token) {
    if (redisService.isRedisEnabled()) {
        const result = await redisService.getRedisClient().get('TOK_' + token);
        return result === 'true';
    }
    return !_.isNil(blackList[token]);
};

function updateRefreshedTokenInSharedDb(previousToken, newToken) {
    blackListToken(previousToken);
    // This might not be necessary
    // blackList[newToken] = false;
};

async function blackListToken(token) {
    // when a token is refreshed, the previous token might still be valid for a little time
    // if someone gains access to it, a new session could be started
    // When a user logs out (manually or on session timeout), the token is still valid and could be reused.
    if (redisService.isRedisEnabled()) {
        // the token will auto expires and be removed from the black list in redis
        await redisService.getRedisClient().set('TOK_' + token, true, 'EXP', tokenDisposalInMins * 60 * 1000);
    } else {
        // Set some disposal date (not accurate but surely greater that the remaining validity time)
        blackList[token] = moment().add(tokenDisposalInMins, 'minutes').toDate();
    }
}

function clearBlackList() {
    // for test purposes
    blackList = {};
};

function scheduleTokenMaintenance(disposalIntervalInMins, tokenExpiresInMins) {
    if (redisService.isRedisEnabled()) {
        // Token will expire by themselves thanks to redis
        // Token should not be removed until they have expired
        // add 5% just to make sure there is no security hole.
        tokenDisposalInMins = (tokenExpiresInMins * 105) / 100;
        return;
    }
    setInterval(() => {
        logger.debug('Start server token maintenance.');
        removeExpiredEventFromBlackList();
    }, (disposalIntervalInMins || (60 * 5)) * 1000);
}

function removeExpiredEventFromBlackList() {
    for (const token in blackList) {
        if (moment().isAfter(blackList[token])) {
            logger.debug('Remove expired token from blackList.', token);
            delete blackList[token];
        }
    }
}
