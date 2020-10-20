'use strict';
const moment = require('moment');
const utils = require('../lib/utils');

describe('utils', () => {
    let fn;

    beforeEach(() => {
        const now = moment('Feb 6 2020 05:06:07', 'MMM DD YYYY hh:mm:ss').toDate();
        jasmine.clock().install();
        jasmine.clock().mockDate(now);
        fn = jasmine.createSpy('fn');
        spyOn(utils, '_setTimeout').and.callThrough();
    });

    afterEach(() => {
        jasmine.clock().uninstall();
    });

    describe('setLongTimeout', () => {
        it('should timeout at once', async () => {
            utils.setLongTimeout(fn, 30);
            jasmine.clock().tick(30 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledWith(fn, 1800000);
        });

        it('should timeout at the max value instead', async () => {
            utils.setLongTimeout(fn, 100, {max: 30});
            jasmine.clock().tick(30 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledWith(fn, 1800000);
        });

        it('should not timeout', async () => {
            utils.setLongTimeout(fn, 30);
            jasmine.clock().tick(15 * 60 * 1000);
            expect(fn).not.toHaveBeenCalled();
        });

        it('should timeout in 1 cycle', async () => {
            const days = 20;
            const timeout = utils.setLongTimeout(fn, days * 24 * 60);
            expect(timeout.remainingDays).toEqual(0);
            expect(timeout.remainingMins).toEqual(28800);
            jasmine.clock().tick(20 * 24 * 60 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledWith(fn, 1728000000);
        });

        it('should timeout in 2 cycles', async () => {
            const days = 21;
            const timeout = utils.setLongTimeout(fn, days * 24 * 60);
            expect(timeout.remainingDays).toEqual(21);
            expect(timeout.remainingMins).toEqual(0);
            jasmine.clock().tick(21 * 24 * 60 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledTimes(2);
            expect(utils._setTimeout.calls.argsFor(0)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(1)).toEqual([fn, 86400000]);
        });

        it('should timeout in 3 cycles', async () => {
            const days = 41;
            const timeout = utils.setLongTimeout(fn, days * 24 * 60);
            expect(timeout.remainingDays).toEqual(41);
            expect(timeout.remainingMins).toEqual(0);
            jasmine.clock().tick(41 * 24 * 60 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledTimes(3);
            expect(utils._setTimeout.calls.argsFor(0)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(1)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(2)).toEqual([fn, 86400000]);
        });

        it('should use the maximum timeout', async () => {
            const days = 1000000;
            const timeout = utils.setLongTimeout(fn, days * 24 * 60, {max: 41 * 24 * 60});
            expect(timeout.remainingDays).toEqual(41);
            expect(timeout.remainingMins).toEqual(0);
            jasmine.clock().tick(41 * 24 * 60 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(1);
            expect(utils._setTimeout).toHaveBeenCalledTimes(3);
            expect(utils._setTimeout.calls.argsFor(0)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(1)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(2)).toEqual([fn, 86400000]);
        });
    });

    describe('clearLongTimeout', () => {
        it('should clear timeout', async () => {
            const timeout = utils.setLongTimeout(fn, 30);
            utils.clearLongTimeout(timeout);
            jasmine.clock().tick(30 * 60 * 1000);
            expect(fn).toHaveBeenCalledTimes(0);
        });

        it('should clear timeout during 2nd cycle', async () => {
            const days = 21;
            const timeout = utils.setLongTimeout(fn, days * 24 * 60);
            jasmine.clock().tick(20 * 24 * 60 * 60 * 1000);
            utils.clearLongTimeout(timeout);
            expect(fn).not.toHaveBeenCalled();
            expect(utils._setTimeout).toHaveBeenCalledTimes(2);
            expect(utils._setTimeout.calls.argsFor(0)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(1)).toEqual([fn, 86400000]);
        });

        it('should clear timeout during 2nd cycle preventing from running a 3rd cycle', async () => {
            const days = 41;
            const timeout = utils.setLongTimeout(fn, days * 24 * 60);
            expect(timeout.remainingDays).toEqual(41);
            expect(timeout.remainingMins).toEqual(0);
            jasmine.clock().tick(39 * 24 * 60 * 60 * 1000);
            utils.clearLongTimeout(timeout);
            expect(fn).not.toHaveBeenCalled();
            expect(utils._setTimeout).toHaveBeenCalledTimes(2);
            expect(utils._setTimeout.calls.argsFor(0)).toEqual([jasmine.any(Function), 1728000000]);
            expect(utils._setTimeout.calls.argsFor(1)).toEqual([jasmine.any(Function), 1728000000]);
        });
    });
});
