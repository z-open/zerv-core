
'strict mode';

const _ = require('lodash');
const IoRedis = require('ioredis');
let redisClient;


module.exports = {
    getRedisClient,
    isRedisEnabled
};

/**
 * this returns a redis client.
 * Notes:
 * This should evolve to deal with error handling and redis cluster configuration
 * We might also consider connecting different redis servers for different needs (system or tenant data)
 * @returns {IoRedis}
 */
function getRedisClient() {
    // if (!redisClient) {
    if (!redisClient && process.env.REDIS_ENABLED === 'true') {
        // --------------------------
        // Later on, let's use instead the redis client initalized in zerv-sync/clustering
        // if there were any error, zerv-sync will throw errors anyway
        const connectionParams = {
            port: process.env.REDIS_PORT || 6379,
            host: process.env.REDIS_HOST || '127.0.0.1',
            // We should use a prefix so that we can use the same redis server with different environments (not prod)
            // keyPrefix: process.env.NODE_ENV
        };
        // @ts-ignore
        redisClient = new IoRedis(connectionParams);
        // --------------------------
    }
    return redisClient;
}

function isRedisEnabled() {
    return !_.isNil(getRedisClient());
}
