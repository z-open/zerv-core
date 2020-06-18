'use strict';
const moment = require('moment');
const _ = require('lodash');
const service = require('../lib/cache.service');

describe('cache.service', () => {
    let dataKey, somePrefix, dataValue, dataObject;
    beforeEach(() => {
        process.env.REDIS_ENABLED = true;
        dataKey = 'nameOfCachedData';
        dataValue = 123;
        dataObject = {id: 'd234a', name: 'King'};
        somePrefix = 'namespace';

        spyOn(service, 'getRedisClient').and.returnValue({
            setex: jasmine.createSpy('getRedisClient.setex').and.returnValues(Promise.resolve()),
            set: jasmine.createSpy('getRedisClient.set').and.returnValues(Promise.resolve()),
            del: jasmine.createSpy('getRedisClient.del').and.returnValues(Promise.resolve()),
            get: jasmine.createSpy('getRedisClient.get').and.returnValues(Promise.resolve())
        });
    });

    afterEach(() => {
        process.env.REDIS_ENABLED = false;
    });

    describe('getRedisClient function', () => {
        beforeEach(() => {
            service.getRedisClient.and.callThrough();
        });

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

    it('isClusterCacheEnabled should return true', async () => {
        service.getRedisClient.and.callThrough();
        expect(service.isClusterCacheEnabled()).toBeTrue();
    });

    it('isClusterCacheEnabled should return the cached client', async () => {
        service.getRedisClient.and.callThrough();
        process.env.REDIS_ENABLED = false;
        expect(service.isClusterCacheEnabled()).toBeFalse();
    });

    it('cacheData should cache data', async () => {
        await service.cacheData(dataKey, dataValue);
        expect(service.getRedisClient().set).toHaveBeenCalledWith(dataKey, dataValue);
    });

    it('cacheData should cache data with a prefix', async () => {
        await service.cacheData(dataKey, dataValue, {prefix: somePrefix});
        expect(service.getRedisClient().set).toHaveBeenCalledWith('namespacenameOfCachedData', dataValue);
    });

    it('cacheData should cache data with expirationInMins', async () => {
        await service.cacheData(dataKey, dataValue, {expirationInMins: 10});
        expect(service.getRedisClient().setex).toHaveBeenCalledWith(dataKey, 10 * 60, dataValue);
    });

    it('removeCachedData should remove cached data', async () => {
        await service.removeCachedData(dataKey);
        expect(service.getRedisClient().del).toHaveBeenCalledWith(dataKey);
    });

    it('removeCachedData should cache data with a prefix', async () => {
        await service.removeCachedData(dataKey, {prefix: somePrefix});
        expect(service.getRedisClient().del).toHaveBeenCalledWith('namespacenameOfCachedData');
    });

    it('getCachedData should get cached data', async () => {
        service.getRedisClient().get.and.returnValue(Promise.resolve(dataValue));
        const result = await service.getCachedData(dataKey);
        expect(result).toEqual(dataValue);
        expect(service.getRedisClient().get).toHaveBeenCalledWith(dataKey);
    });

    it('getCachedData should get data with a prefix', async () => {
        service.getRedisClient().get.and.returnValue(Promise.resolve(dataValue));
        const result = await service.getCachedData(dataKey, {prefix: somePrefix});
        expect(result).toEqual(dataValue);
        expect(service.getRedisClient().get).toHaveBeenCalledWith('namespacenameOfCachedData');
    });

    it('getCachedObject should get the object', async () => {
        spyOn(service, 'getCachedData').and.callThrough();
        service.getRedisClient().get.and.returnValue(Promise.resolve(JSON.stringify(dataObject)));
        const result = await service.getCachedObject(dataKey, {prefix: somePrefix});
        expect(result).toEqual(dataObject);
        expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
    });

    it('getCachedBooleanValue should get true', async () => {
        spyOn(service, 'getCachedData').and.callThrough();
        service.getRedisClient().get.and.returnValue(Promise.resolve('true'));
        const result = await service.getCachedBooleanValue(dataKey, {prefix: somePrefix});
        expect(result === true).toBeTrue();
        expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
    });

    it('getCachedBooleanValue should get false when data is missing', async () => {
        spyOn(service, 'getCachedData').and.callThrough();
        service.getRedisClient().get.and.returnValue(null);
        const result = await service.getCachedBooleanValue(dataKey, {prefix: somePrefix});
        expect(result).toBe(false);
        expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
    });

    it('getCachedBooleanValue should get false', async () => {
        spyOn(service, 'getCachedData').and.callThrough();
        service.getRedisClient().get.and.returnValue('false');
        const result = await service.getCachedBooleanValue(dataKey, {prefix: somePrefix});
        expect(result).toBe(false);
        expect(service.getCachedData).toHaveBeenCalledWith(dataKey, {prefix: somePrefix});
    });

});
