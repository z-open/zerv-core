'use strict';
const moment = require('moment');
const service = require('../lib/cache.service');

describe('cache.service', () => {
    let dataKey, somePrefix, dataValue, dataObject;
    beforeEach(() => {
        process.env.REDIS_ENABLED = true;
        dataKey = 'nameOfCachedData';
        dataValue = 123;
        dataObject = {id: 'd234a', name: 'King'};
        somePrefix = 'namespace';

        spyOn(service, 'getRedisClient').and.callThrough();
        spyOn(service, '_getCacheImpl').and.returnValue({
            setex: jasmine.createSpy('_getCacheImpl.setex').and.returnValues(Promise.resolve()),
            set: jasmine.createSpy('_getCacheImpl.set').and.returnValues(Promise.resolve()),
            del: jasmine.createSpy('_getCacheImpl.del').and.returnValues(Promise.resolve()),
            get: jasmine.createSpy('_getCacheImpl.get').and.returnValues(Promise.resolve())
        });
    });

    afterEach(() => {
        process.env.REDIS_ENABLED = false;
    });

    describe('getRedisClient function', () => {
        it('getRedisClient should return the redis client', async () => {
            const result = service.getRedisClient();
            expect(result.constructor.name).toBe('Redis');
        });

        it('getRedisClient should return the cached client', async () => {
            const cached = service.getRedisClient();
            expect(service.getRedisClient()).toBe(cached);
        });

        it('getRedisClient should return the cached client', async () => {
            process.env.REDIS_ENABLED = false;
            const client = service.getRedisClient();
            expect(client).toBeNull();
        });
    });

    describe('isClusterCacheEnabled function', () => {
        it('should return true', async () => {
            expect(service.isClusterCacheEnabled()).toBeTrue();
        });

        it('should return the cached client', async () => {
            process.env.REDIS_ENABLED = false;
            expect(service.isClusterCacheEnabled()).toBeFalse();
        });
    });

    describe('_getCacheImpl function', () => {
        it('should return redis implementation', async () => {
            service._getCacheImpl.and.callThrough();
            const result = service._getCacheImpl();
            expect(result.constructor.name).toBe('Redis');
        });
        it('should return local cache implementation', async () => {
            service._getCacheImpl.and.callThrough();
            process.env.REDIS_ENABLED = false;
            const result = service._getCacheImpl();
            expect(result.constructor.name).toBe('LocalCache');
        });
    });

    describe('LocalCache', () => {
        let localCache;
        let now;

        beforeEach(() => {
            now = moment('Feb 6 2020 05:06:07', 'MMM DD YYYY hh:mm:ss').toDate();
            jasmine.clock().install();
            jasmine.clock().mockDate(now);
            process.env.REDIS_ENABLED = false;
            service._getCacheImpl.and.callThrough();
            service._disableLocalCacheFilePersistence();
            localCache = service._getCacheImpl();
            spyOn(localCache, 'persistCache');
            spyOn(localCache, 'removeExpiredKeys').and.callThrough();
        });

        afterEach(() => {
            jasmine.clock().uninstall();
        });

        it('persistCache shoud call the persistence implementation', async () => {
            spyOn(service, '_getLocalCachePersistenceImpl');
        });

        it('setex should store data with expiration', async () => {
            localCache.setex('myKey', 5000, 'theValue');
            const exp = moment(now);
            exp.add(5000, 'seconds');
            expect(localCache.persistCache).toHaveBeenCalledTimes(1);
            expect(localCache.data).toEqual({
                myKey: {
                    val: 'theValue',
                    exp: exp.toDate()
                }
            });
        });
        it('set should store data with no expiration', async () => {
            localCache.set('myKey', 'theValue');
            expect(localCache.persistCache).toHaveBeenCalledTimes(1);
            expect(localCache.persistCache).toHaveBeenCalledWith();
            expect(localCache.data).toEqual({
                myKey: {
                    val: 'theValue',
                    exp: null
                }
            });
        });

        it('set should replace data without losing the expiration', async () => {
            localCache.setex('myKey', 5000, 'theValue');
            const exp = moment(now);
            exp.add(5000, 'seconds');
            localCache.set('myKey', 'theValueEdited');
            expect(localCache.persistCache).toHaveBeenCalledTimes(2);
            expect(localCache.data).toEqual({
                myKey: {
                    val: 'theValueEdited',
                    exp: exp.toDate()
                }
            });
        });

        it('del should remove a key and its data immediately', async () => {
            localCache.set('myKey', 'theValue');
            localCache.del('myKey');
            expect(localCache.persistCache).toHaveBeenCalledTimes(2);
            expect(localCache.data).toEqual({});
        });

        it('clearAll should remove all data', async () => {
            localCache.set('myKey', 'theValue');
            localCache.clearAll();
            expect(localCache.persistCache).toHaveBeenCalledTimes(1);
            expect(localCache.data).toEqual({});
        });

        it('removeExpiredKeys should remove expired keys only', async () => {
            localCache.setex('myKey', 60, 'theValue');
            const exp = moment(now);
            exp.add(60, 'seconds');
            localCache.setex('myKey1', 5, 'theValue1');
            localCache.set('myKey2', 'theValue2');
            jasmine.clock().tick(6000);
            localCache.removeExpiredKeys();
            expect(localCache.data).toEqual({
                myKey: {
                    val: 'theValue',
                    exp: exp.toDate()
                },
                myKey2: {
                    val: 'theValue2',
                    exp: null
                }
            });
        });
    });


    describe('cacheData function', () => {
        it('should cache data', async () => {
            await service.cacheData(dataKey, dataValue);
            expect(service._getCacheImpl().set).toHaveBeenCalledWith(dataKey, JSON.stringify(dataValue));
        });

        it('should cache object', async () => {
            await service.cacheData(dataKey, dataObject);
            expect(service._getCacheImpl().set).toHaveBeenCalledWith(dataKey, JSON.stringify(dataObject));
        });

        it('should cache data with a prefix', async () => {
            await service.cacheData(dataKey, dataValue, {prefix: somePrefix});
            expect(service._getCacheImpl().set).toHaveBeenCalledWith('namespacenameOfCachedData', JSON.stringify(dataValue));
        });

        it('should cache data with expirationInMins', async () => {
            await service.cacheData(dataKey, dataValue, {expirationInMins: 10});
            expect(service._getCacheImpl().setex).toHaveBeenCalledWith(dataKey, 10 * 60, JSON.stringify(dataValue));
        });
    });

    describe('removeCachedData function', () => {
        it('should remove cached data', async () => {
            await service.removeCachedData(dataKey);
            expect(service._getCacheImpl().del).toHaveBeenCalledWith(dataKey);
        });

        it('should cache data with a prefix', async () => {
            await service.removeCachedData(dataKey, {prefix: somePrefix});
            expect(service._getCacheImpl().del).toHaveBeenCalledWith('namespacenameOfCachedData');
        });
    });

    describe('getCachedData function', () => {
        it('should get cached data', async () => {
            service._getCacheImpl().get.and.returnValue(Promise.resolve(dataValue));
            const result = await service.getCachedData(dataKey);
            expect(result).toEqual(dataValue);
            expect(service._getCacheImpl().get).toHaveBeenCalledWith(dataKey);
        });

        it('should get data with a prefix', async () => {
            service._getCacheImpl().get.and.returnValue(Promise.resolve(dataValue));
            const result = await service.getCachedData(dataKey, {prefix: somePrefix});
            expect(result).toEqual(dataValue);
            expect(service._getCacheImpl().get).toHaveBeenCalledWith('namespacenameOfCachedData');
        });

        it('should get the object', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue(Promise.resolve(JSON.stringify(dataObject)));
            const result = await service.getCachedObject(dataKey, {prefix: somePrefix});
            expect(result).toEqual(dataObject);
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
        });

        it('should get true', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue(Promise.resolve('true'));
            const result = await service.getCachedBooleanValue(dataKey, {prefix: somePrefix});
            expect(result === true).toBeTrue();
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
        });

        it('getCachedBooleanValue should get false when data is missing', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue(null);
            const result = await service.getCachedBooleanValue(dataKey, {prefix: somePrefix});
            expect(result).toBe(false);
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
        });

        it('getCachedBooleanValue should get false', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue('false');
            const result = await service.getCachedBooleanValue(dataKey, {prefix: somePrefix});
            expect(result).toBe(false);
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
        });
    });
});
