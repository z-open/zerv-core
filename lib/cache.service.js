
'strict mode';

const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const IoRedis = require('ioredis');
const moment = require('moment');
const zlog = require('zimit-zlog');
const logger = zlog.getLogger('zerv/core/cacheService');

let redisClient;
let localCache;

/**
 * this service provides access to a persisted cache implementation:
 * - in redis (when cluster/redis is enabled),
 * - or file
 * - or memory
 * The future goals are to provide:
 * - user session storage capabilities over the zerv infrastructure, that will be released on user session completion (session timeout or logout)
 * - cache transaction and locking mechanism to garanty data integraty whatever chosen implementation
 */
const service = {
    getRedisClient,
    isClusterCacheEnabled,

    cacheData,
    removeCachedData,
    getCachedData,
    getCachedBooleanValue,
    getCachedObject,

    getCachedKeys,
    getCachedObjects,
    getCachedObjectsWithKeyNameBeginning,

    _getCacheImpl,
    _clearLocalCache,
    _getLocalCachePersistenceImpl,
    _disableLocalCacheFilePersistence
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
        logger.info('Redis Cache enabled - host: %b - port: %b', connectionParams.host, connectionParams.port);
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

function _getCacheImpl() {
    if (isClusterCacheEnabled()) {
        return service.getRedisClient();
    }
    return getLocalCache();
}

// This quick keystore cache implementation is useful for development only.
// It is not shared.
// By default the cache will be persisted on the disk.
class LocalCache {
    constructor(enablePersistence = true) {
        this.data = {};
        this.persistCache = _.throttle(service._getLocalCachePersistenceImpl(this, enablePersistence), 1000);
    }

    setex(key, exp, value) {
        this.data[key] = {val: value, exp: getExpirationDate(exp)};
        this.persistCache();
    }
    set(key, value) {
        // similar behavior as redis, set maintain the exp set earlier
        const oldData = this.data[key];
        this.data[key] = {val: value, exp: oldData ? oldData.exp : null};
        this.persistCache();
    }
    del(key) {
        delete this.data[key];
        this.persistCache();
    }
    get(key) {
        return Promise.resolve(_.get(this.data[key], 'val', null));
    }
    mget(keys) {
        // could return undefined values if not found
        return Promise.resolve(_.map(keys, (key) => _.get(this.data[key], 'val')));
    }
    scanStream(options) {
        let dataFn;
        const match = options.match.substr(0, options.match.length - 1);
        return {
            on: (event, fn) => {
                if (event === 'data') {
                    dataFn = fn;
                } else if (event === 'end') {
                    const keys = _.keys(this.data);
                    console.log('keys', keys, match);
                    dataFn(_.filter(keys, (key) => key.indexOf(match) !== -1));
                    fn();
                }
            }
        };
    }
    clearAll() {
        this.data = {};
    }

    removeExpiredKeys() {
        const data = this.data;
        _.forEach(_.keys(data), (key) => {
            const obj = data[key];
            if (obj.exp && moment().isAfter(obj.exp)) {
                logger.debug('Remove key %b expired on %s.', key, moment(obj.exp));
                delete data[key];
            }
        });
    }
}

function _getLocalCachePersistenceImpl(localCache, enablePersistence) {
    if (!enablePersistence) {
        logger.info('In-memory Keystore Enabled (no redis) - No persistence');
        return () => localCache.removeExpiredKeys(localCache.data);
    }

    const cacheDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir);
    }

    // Small precaution so that all envs do not use the same local cache file.
    const cacheFileName = path.join(cacheDir, `zcache${process.env.NODE_ENV ? '-' + process.env.NODE_ENV : ''}.json`);
    logger.info('In-memory keystore Enabled (no redis) - Disk persistence: ' + cacheFileName);

    try {
        const content = fs.readFileSync(cacheFileName, 'utf8');
        localCache.data = JSON.parse(content);
    } catch (err) {
        logger.warn('Error loading %s - %s', cacheFileName, err.message);
        localCache.data = {};
    }
    localCache.removeExpiredKeys();

    return () => {
        try {
            localCache.removeExpiredKeys();
            fs.writeFileSync(cacheFileName, JSON.stringify(localCache.data, null, 1));
        } catch (err) {
            logger.error(err);
        }
    };
}

function getExpirationDate(expirationInSecs) {
    if (_.isNil(expirationInSecs)) {
        return null;
    }
    const expirationDate = moment();
    expirationDate.add(expirationInSecs, 'seconds');
    return expirationDate.toDate();
}

function getLocalCache(enablePersistence = true) {
    if (!localCache) {
        localCache = new LocalCache(enablePersistence);
    }
    return localCache;
}

function _clearLocalCache() {
    getLocalCache().clearAll();
}

function _disableLocalCacheFilePersistence() {
    localCache = null;
    getLocalCache(false);
}

async function cacheData(key, value, options = {}) {
    const data = JSON.stringify(value);
    if (_.isNumber(options.expirationInMins)) {
        await service._getCacheImpl().setex(formatKeyName(key, options.prefix), options.expirationInMins * 60, data);
    } else {
        await service._getCacheImpl().set(formatKeyName(key, options.prefix), data);
    }
}

async function removeCachedData(key, options = {}) {
    await service._getCacheImpl().del(formatKeyName(key, options.prefix));
}

async function getCachedData(key, options = {}) {
    const result = await service._getCacheImpl().get(formatKeyName(key, options.prefix));
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

async function getCachedObjects(keys, options = {}) {
    if (!keys.length) {
        return [];
    }
    if (!_.isEmpty(options.prefix)) {
        keys = _.map(keys, (key) => formatKeyName(key, options.prefix));
    }
    const values = await service._getCacheImpl().mget(keys);
    try {
        const results = [];
        for (const value of values) {
            if (!_.isNil(value)) {
                results.push(JSON.parse(value));
            }
        }
        return results;
    } catch (err) {
        logger.error(err, values);
        throw err;
    }
}

async function getCachedObjectsWithKeyNameBeginning(keyNameBeginningToMatch, options = {}) {
    if (!_.isEmpty(options.prefix)) {
        keyNameBeginningToMatch = formatKeyName(keyNameBeginningToMatch, options.prefix);
    }
    const keys = await service.getCachedKeys(keyNameBeginningToMatch);
    return service.getCachedObjects(keys);
}

async function getCachedKeys(keyNameBeginningToMatch, options = {}) {
    const result = await new Promise((resolve, reject) => {
        const keys = [];

        // scanStream seems not supported by redis cluster... it could be an issue later on.
        const stream = service._getCacheImpl().scanStream({
            match: formatKeyName(keyNameBeginningToMatch, options.prefix) + '*',
            // returns approximately 100 elements per call
            count: options.batchSize || 100,
        });

        stream.on('data', (resultKeys) => {
            // `resultKeys` is an array of strings representing key names.
            // Note that resultKeys may contain 0 keys, and that it will sometimes
            // contain duplicates due to SCAN's implementation in Redis.
            keys.push(...resultKeys);
        });

        stream.on('end', () => {
            resolve(_.uniq(keys));
        });
        // not tested... not in doc but in ioredis code
        stream.on('error', (err) => {
            reject(err);
        });
    });

    if (options.prefix) {
        return _.map(result, (key) => key.substring(options.prefix.length));
    }
    return result;
}

function formatKeyName(key, prefix) {
    return !_.isEmpty(prefix) ? prefix + key : key; ;
}
