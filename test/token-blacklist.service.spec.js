'use strict';
const moment = require('moment');
const service = require('../lib/token-blacklist.service');
const cacheService = require('../lib/cache.service');

describe('token-blacklist.service', () => {
    let now;
    let token;

    beforeEach(() => {
        now = moment('Feb 6 2020 05:06:07', 'MMM DD YYYY hh:mm:ss').toDate();
        jasmine.clock().install();
        jasmine.clock().mockDate(now);

        spyOn(cacheService, 'cacheData').and.returnValue(Promise.resolve());
        spyOn(cacheService, 'getCachedData').and.returnValue(Promise.resolve());

        token = '123';
    });

    afterEach(() => {
        jasmine.clock().uninstall();
    });


    describe('revokeToken function', () => {
        it('should store a valid token in the cache', async () => {
            // this is the way jsonwebtoken compute the iat which is saved in the token payload
            const iat = Math.round(now.getTime() / 1000);
            // and expiration date
            const exp = iat + 63 * 60;
            await service.revokeToken(token, exp);
            expect(cacheService.cacheData).toHaveBeenCalledWith(
                token,
                true,
                {prefix: 'REVOK_TOK_', expirationInMins: 63}
            );
        });

        it('should store a token in the cache for a minute even though it is very close to expire', async () => {
            // this is the way jsonwebtoken compute the iat which is saved in the token payload
            const iat = Math.round(now.getTime() / 1000);
            // and expiration date
            const exp = iat + 1;
            await service.revokeToken(token, exp);
            expect(cacheService.cacheData).toHaveBeenCalledWith(
                token,
                true,
                {prefix: 'REVOK_TOK_', expirationInMins: 1}
            );
        });

        it('should NOT store an expired token in the cache', async () => {
            // this is the way jsonwebtoken compute the iat which is saved in the token payload
            const iat = Math.round(now.getTime() / 1000);
            // and expiration date in the past
            const exp = iat - 10;
            await service.revokeToken(token, exp);
            expect(cacheService.cacheData).not.toHaveBeenCalled();
        });
    });

    describe('isTokenRevoked function', () => {
        it('should check a token existence in redis', async () => {
            cacheService.getCachedData.and.returnValue('true');
            const result = await service.isTokenRevoked(token);
            expect(cacheService.getCachedData).toHaveBeenCalledWith(
                token,
                {prefix: 'REVOK_TOK_'}
            );
            expect(result).toBeTrue();
        });
    });
});
