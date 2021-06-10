'use strict';
const moment = require('moment');
const service = require('../lib/cache.service');

describe('cache.service', () => {
    let dataKey, tenantIdUsedAsPrefix, dataValue, dataKey2, dataObject, dataObject2;
    beforeEach(() => {
        process.env.REDIS_ENABLED = true;
        dataKey = 'florida_member';
        dataKey2 = 'florida_member2';
        dataValue = 123;
        dataObject = {id: 'd234a', name: 'King'};
        dataObject2 = {id: 'z4323', name: 'Lord'};

        tenantIdUsedAsPrefix = 'superTenantId';

        spyOn(service, 'getRedisClient').and.callThrough();
        spyOn(service, '_createIoRedis').and.returnValue({
            constructorName: 'Redis',
        });
        spyOn(service, '_getCacheImpl').and.returnValue({
            setex: jasmine.createSpy('_getCacheImpl.setex').and.returnValues(Promise.resolve()),
            set: jasmine.createSpy('_getCacheImpl.set').and.returnValues(Promise.resolve()),
            del: jasmine.createSpy('_getCacheImpl.del').and.returnValues(Promise.resolve()),
            get: jasmine.createSpy('_getCacheImpl.get').and.returnValues(Promise.resolve()),
            mget: jasmine.createSpy('_getCacheImpl.mget').and.returnValues(Promise.resolve()),
            scanStream: jasmine.createSpy('_getCacheImpl.scanStream').and.callThrough()
        });
    });

    afterEach(() => {
        process.env.REDIS_ENABLED = false;
        service._clearIoRedisInstance();
    });

    it('_createIoRedis should return the redis instance', () => {
        service._createIoRedis.and.callThrough();
        const result = service._createIoRedis();
        expect(result.constructor.name).toBe('Redis');
        try {
            // prevent attempt to connecting redis and throwing error in test
            result.end();
        } catch(err) {
            // swallow any err, 
        }
    });

    describe('getRedisClient function', () => {
        it('getRedisClient should return the redis client', async () => {
            const result = service.getRedisClient();
            expect(result.constructorName).toBe('Redis');
            expect(service._createIoRedis).toHaveBeenCalledTimes(1);
            expect(service._createIoRedis).toHaveBeenCalledWith();
        });

        it('getRedisClient should return the cached client', async () => {
            const cached = service.getRedisClient();
            expect(service.getRedisClient()).toBe(cached);
        });

        it('getRedisClient should return null when redis is disabled', async () => {
            process.env.REDIS_ENABLED = false;
            const client = service.getRedisClient();
            expect(client).toBeNull();
        });
    });

    describe('isClusterCacheEnabled function', () => {
        it('should return true when redis is enabled', async () => {
            expect(service.isClusterCacheEnabled()).toBeTrue();
        });

        it('should return false when redis is disabled', async () => {
            process.env.REDIS_ENABLED = false;
            expect(service.isClusterCacheEnabled()).toBeFalse();
        });
    });

    describe('_getCacheImpl function', () => {
        it('should return redis implementation', async () => {
            service._getCacheImpl.and.callThrough();
            const result = service._getCacheImpl();
            expect(result.constructorName).toBe('Redis');
            expect(service._createIoRedis).toHaveBeenCalledTimes(1);
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
            now = moment('2020-02-06T10:06:07Z').toDate();
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
            await service.cacheData(dataKey, dataValue, {prefix: tenantIdUsedAsPrefix});
            expect(service._getCacheImpl().set).toHaveBeenCalledWith('superTenantIdflorida_member', JSON.stringify(dataValue));
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
            await service.removeCachedData(dataKey, {prefix: tenantIdUsedAsPrefix});
            expect(service._getCacheImpl().del).toHaveBeenCalledWith('superTenantIdflorida_member');
        });
    });

    describe('basic getCachedData function', () => {
        it('should get cached data', async () => {
            service._getCacheImpl().get.and.returnValue(Promise.resolve(dataValue));
            const result = await service.getCachedData(dataKey);
            expect(result).toEqual(dataValue);
            expect(service._getCacheImpl().get).toHaveBeenCalledWith(dataKey);
        });

        it('should get data with a prefix', async () => {
            service._getCacheImpl().get.and.returnValue(Promise.resolve(dataValue));
            const result = await service.getCachedData(dataKey, {prefix: tenantIdUsedAsPrefix});
            expect(result).toEqual(dataValue);
            expect(service._getCacheImpl().get).toHaveBeenCalledWith('superTenantIdflorida_member');
        });

        it('should get the object', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue(Promise.resolve(JSON.stringify(dataObject)));
            const result = await service.getCachedObject(dataKey, {prefix: tenantIdUsedAsPrefix});
            expect(result).toEqual(dataObject);
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: tenantIdUsedAsPrefix});
        });

        it('should get true', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue(Promise.resolve('true'));
            const result = await service.getCachedBooleanValue(dataKey, {prefix: tenantIdUsedAsPrefix});
            expect(result === true).toBeTrue();
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: tenantIdUsedAsPrefix});
        });

        it('getCachedBooleanValue should get false when data is missing', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue(null);
            const result = await service.getCachedBooleanValue(dataKey, {prefix: tenantIdUsedAsPrefix});
            expect(result).toBe(false);
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: tenantIdUsedAsPrefix});
        });

        it('getCachedBooleanValue should get false', async () => {
            spyOn(service, 'getCachedData').and.callThrough();
            service._getCacheImpl().get.and.returnValue('false');
            const result = await service.getCachedBooleanValue(dataKey, {prefix: tenantIdUsedAsPrefix});
            expect(result).toBe(false);
            expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: tenantIdUsedAsPrefix});
        });
    });

    describe('getCachedObjects function', () => {
        it('should return multiple objects based on prefix', async () => {
            service._getCacheImpl().mget.and.returnValue(Promise.resolve([
                JSON.stringify(dataObject), JSON.stringify(dataObject2)]
            ));
            const result = await service.getCachedObjects([dataKey, dataKey2], {prefix: tenantIdUsedAsPrefix});
            expect(result).toEqual([dataObject, dataObject2]);
            expect(service._getCacheImpl().mget).toHaveBeenCalledWith([tenantIdUsedAsPrefix + dataKey, tenantIdUsedAsPrefix + dataKey2]);
        });

        it('should return multiple objects based on NO prefix', async () => {
            service._getCacheImpl().mget.and.returnValue(Promise.resolve([
                JSON.stringify(dataObject), JSON.stringify(dataObject2)]
            ));
            const result = await service.getCachedObjects([dataKey, dataKey2]);
            expect(result).toEqual([dataObject, dataObject2]);
            expect(service._getCacheImpl().mget).toHaveBeenCalledWith([dataKey, dataKey2]);
        });

        it('should return an empty array when no keys are passed', async () => {
            service._getCacheImpl().mget.and.returnValue(Promise.resolve([
                JSON.stringify(dataObject), JSON.stringify(dataObject2)
            ]));
            const result = await service.getCachedObjects([]);
            expect(result).toEqual([]);
            expect(service._getCacheImpl().mget).not.toHaveBeenCalled();
        });
    });

    describe('getCachedObjectsWithKeyNameBeginning function', () => {
        it('should return multiple objects based on prefix', async () => {
            spyOn(service, 'getCachedKeys').and.callFake((keyNameBeginningToMatch) =>
                Promise.resolve([
                    keyNameBeginningToMatch + '_restOfKey1', keyNameBeginningToMatch + '_restOfKey2'
                ])
            );
            spyOn(service, 'getCachedObjects').and.callFake((keys) =>
                Promise.resolve('an array result returning objects for ' + keys)
            );
            const result = await service.getCachedObjectsWithKeyNameBeginning('keynameBeginning', {prefix: tenantIdUsedAsPrefix});
            expect(result).toEqual('an array result returning objects for superTenantIdkeynameBeginning_restOfKey1,superTenantIdkeynameBeginning_restOfKey2');
            expect(service.getCachedObjects).toHaveBeenCalledWith(['superTenantIdkeynameBeginning_restOfKey1', 'superTenantIdkeynameBeginning_restOfKey2']);
        });

        it('should return multiple objects based on NO prefix', async () => {
            spyOn(service, 'getCachedKeys').and.callFake((keyNameBeginningToMatch) =>
                Promise.resolve([
                    keyNameBeginningToMatch + '_restOfKey1', keyNameBeginningToMatch + '_restOfKey2'
                ])
            );
            spyOn(service, 'getCachedObjects').and.callFake((keys) =>
                Promise.resolve('an array result returning objects for ' + keys)
            );
            const result = await service.getCachedObjectsWithKeyNameBeginning('keynameBeginning');
            expect(result).toEqual('an array result returning objects for keynameBeginning_restOfKey1,keynameBeginning_restOfKey2');
            expect(service.getCachedObjects).toHaveBeenCalledWith(['keynameBeginning_restOfKey1', 'keynameBeginning_restOfKey2']);
        });
    });

    describe('getCachedKeys function', () => {
        beforeEach(async () => {
            // force to use the local implementation
            process.env.REDIS_ENABLED = false;
            service._getCacheImpl.and.callThrough();
            service._disableLocalCacheFilePersistence();
            // Use the local impl of scanStream which is a mock of redis scanStream
            spyOn(service._getCacheImpl(), 'scanStream').and.callThrough();
        });

        it('should return multiple objects for the search based on prefix', async () => {
            await service.cacheData(dataKey, dataObject, {prefix: tenantIdUsedAsPrefix});
            await service.cacheData(dataKey2, dataObject2, {prefix: tenantIdUsedAsPrefix});
            await service.cacheData('someother key', {dsf: 'someValue'}, {prefix: tenantIdUsedAsPrefix});

            const result = await service.getCachedKeys('florida', {prefix: tenantIdUsedAsPrefix});
            expect(result).toEqual([dataKey, dataKey2]);
            expect(service._getCacheImpl().scanStream).toHaveBeenCalledWith({match: 'superTenantIdflorida*', count: 100});
        });

        it('should return multiple objects for the search based on NO prefix', async () => {
            await service.cacheData(dataKey, dataObject);
            await service.cacheData(dataKey2, dataObject2);
            await service.cacheData('someother key', {dsf: 'someValue'});

            const result = await service.getCachedKeys('florida');
            expect(result).toEqual([dataKey, dataKey2]);
            expect(service._getCacheImpl().scanStream).toHaveBeenCalledWith({match: 'florida*', count: 100});
        });
    });
});
