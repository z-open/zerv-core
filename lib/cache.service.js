
'strict mode';

const _ = require('lodash');
const IoRedis = require('ioredis');
const zlog = require('zimit-zlog');
const logger = zlog.getLogger('zerv/core/cacheService');

let redisClient;

const service = {
    getRedisClient,
    isClusterCacheEnabled,

    cacheData,
    removeCachedData,
    getCachedData,

    getCachedBooleanValue,
    getCachedObject,
};

module.exports = service;

/**
 * this returns a redis client.
 * Notes:
 * This should evolve to deal with error handling and redis cluster configuration
 * We might also consider connecting different redis servers for different needs (system or tenant data)
 * @returns {IoRedis}
 */
function getRedisClient() {
    // if (!redisClient) {
    if (process.env.REDIS_ENABLED !== 'true') {
        return null;
    }
    if (!redisClient) {
        // --------------------------
        // Later on, let's use instead the redis client initalized in zerv-sync/clustering
        // if there were any error, zerv-sync will throw errors anyway
        const connectionParams = {
            port: process.env.REDIS_PORT || 6379,
            host: process.env.REDIS_HOST || '127.0.0.1',
            // We should use a prefix so that we can use the same redis server with different environments (not prod)
            // keyPrefix: process.env.NODE_ENV
            // some other valuable info
            //  family: 4,           // 4 (IPv4) or 6 (IPv6)
            // password: 'auth',
            // db: 0
            // enableOfflineQueue: false, // do not buffer if there is no connection but return an error,
            // reconnectOnError:function() {
            //     logger.info('error:',arguments)
            // }
        };
        logger.info('Redis: Cache enabled - host: %b - port: %b', connectionParams.host, connectionParams.port);
        // @ts-ignore
        redisClient = new IoRedis(connectionParams);
        redisClient.on('error', onError);
        // --------------------------
    }
    return redisClient;
}

function onError(error) {
    logger.error('Redis Connection error', JSON.stringify(error));
};

function isClusterCacheEnabled() {
    return !_.isNil(service.getRedisClient());
}

async function cacheData(key, value, options = {}) {
    const data = JSON.stringify(value);
    if (options.expirationInMins) {
        await service.getRedisClient().setex(formatKeyName(key, options.prefix), options.expirationInMins * 60, data);
    } else {
        await service.getRedisClient().set(formatKeyName(key, options.prefix), data);
    }
}

async function removeCachedData(key, options = {}) {
    await service.getRedisClient().del(formatKeyName(key, options.prefix));
}

async function getCachedData(key, options = {}) {
    const result = await service.getRedisClient().get(formatKeyName(key, options.prefix));
    return result;
}

async function getCachedBooleanValue(key, options = {}) {
    const result = await service.getCachedData(key, options);
    return result === 'true';
}

async function getCachedObject(key, options = {}) {
    const result = await service.getCachedData(key, options);
    try {
        return _.isNil(result) ? null : JSON.parse(result);
    } catch (err) {
        logger.error(err, result);
        throw err;
    }
}

function formatKeyName(key, prefix) {
    return !_.isEmpty(prefix) ? prefix + key : key; ;
}
