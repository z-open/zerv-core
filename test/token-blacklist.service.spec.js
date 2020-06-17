'use strict';
const moment = require('moment');
const _ = require('lodash');
const service = require('../lib/token-blacklist.service');
const redisService = require('../lib/redis.service');

describe('token-blacklist.service', () => {
    let now;
    let disposalIntervalInMins, tokenExpiresInMins;
    let token, token2;

    beforeEach(() => {
        now = moment('Feb 6 2020 05:06:07', 'MMM DD YYYY hh:mm:ss').toDate();
        jasmine.clock().install();
        jasmine.clock().mockDate(now);

       
        spyOn(redisService, 'isRedisEnabled').and.returnValue(true);
        spyOn(redisService, 'getRedisClient').and.returnValue({
            setex: jasmine.createSpy('getRedisClient.setex').and.returnValues(Promise.resolve()),
            del: jasmine.createSpy('getRedisClient.del').and.returnValues(Promise.resolve()),
            get: jasmine.createSpy('getRedisClient.get').and.returnValues(Promise.resolve())
        });

        disposalIntervalInMins = 120;
        tokenExpiresInMins = 60;
        token = '123';
        token2 = '654';

        service._clearBlackList();

    });

    afterEach(() => {
        jasmine.clock().uninstall();
    });

    describe('scheduleTokenMaintenance function' ,() => {
        it('should determine the token disposal time to set redis token keys with', async () => {
            service.scheduleTokenMaintenance(disposalIntervalInMins, 100)
            await service.revokeToken(token);
            expect(redisService.getRedisClient().setex).toHaveBeenCalledWith(
                'REVOK_TOK_123', 
                105 * 60, // in seconds
                true
            );
            jasmine.clock().tick(1 * 60000);
        });

        it('should run the token removal maintenance when redis is NOT enabled', async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            spyOn(service, '_removeExpiredTokensFromBlackList');
            service.scheduleTokenMaintenance(disposalIntervalInMins, tokenExpiresInMins);
            expect(service._removeExpiredTokensFromBlackList).not.toHaveBeenCalled();
            jasmine.clock().tick(disposalIntervalInMins * 60000);
            expect(service._removeExpiredTokensFromBlackList).toHaveBeenCalled();
        });
    });

    describe('revokeToken function', () => {

        it('should store a token in local memory when redis is not enabled', async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            await service.revokeToken(token);
            expect(await service.isTokenRevoked(token)).toBeTrue();
        });

        it('should store a token in redis', async () => {
            service.scheduleTokenMaintenance(disposalIntervalInMins, tokenExpiresInMins)
            await service.revokeToken(token);
            expect(redisService.getRedisClient().setex).toHaveBeenCalledWith(
                'REVOK_TOK_123', 
                3780,
                true
            );
        });
    });

    describe('isTokenRevoked function', () => {

        it('should check the token existence in local memory when redis is not enabled', async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            expect(await service.isTokenRevoked(token)).toBeFalse();
            await service.revokeToken(token);
            expect(await service.isTokenRevoked(token)).toBeTrue();
        });

        it('should check a token existence in redis', async () => {
            redisService.getRedisClient().get.and.returnValue('true');
            const result = await service.isTokenRevoked(token);
            expect(redisService.getRedisClient().get).toHaveBeenCalledWith(
                'REVOK_TOK_123'
            );
            expect(result).toBeTrue();
        });
    });

    describe('_removeExpiredTokensFromBlackList function', () => {

        beforeEach(async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            service.scheduleTokenMaintenance(1000, tokenExpiresInMins);
            await service.revokeToken(token);
            jasmine.clock().tick((tokenExpiresInMins/2) * 60000);
            await service.revokeToken(token2);
            // add just enough time to make the first token expires
            jasmine.clock().tick((tokenExpiresInMins/2) * 60000 + 240000);
        });

        it('should remove the expired token', async () => {
            service._removeExpiredTokensFromBlackList();
            expect(await service.isTokenRevoked(token)).toBeFalse();
        });

        it('should NOT remove the valid token', async () => {
            service._removeExpiredTokensFromBlackList();
            expect(await service.isTokenRevoked(token2)).toBeTrue();
        });
    });
});
