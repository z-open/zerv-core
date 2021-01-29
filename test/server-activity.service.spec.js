'use strict';
const moment = require('moment');
const service = require('../lib/server-activity.service');

describe('server-activity.service', () => {
    let now;
    beforeEach(() => {
        now = moment('2020-02-06T10:06:07Z').toDate();
        jasmine.clock().install();
        jasmine.clock().mockDate(now);
    });

    afterEach(() => {
        service._clearActivities();
        jasmine.clock().uninstall();
    });

    it('registerNewActivy should add a new activity', () => {
        const activity = service.registerNewActivity('doSomething');
        expect(activity).toEqual({
            call: 'doSomething',
            origin: 'application',
            params: undefined,
            status: 'running',
            start: now,
            end: null,
            done: jasmine.any(Function),
            fail: jasmine.any(Function),
            waitForCompletion: jasmine.any(Function),
        });
        const activities = service.getActivitiesInProcess();
        expect(activities.length).toEqual(1);
    });

    it('activy done method should complete activity', (done) => {
        const activity = service.registerNewActivity('doSomething');

        activity.waitForCompletion()
            .then(() => {
                expect(activity).toEqual({
                    call: 'doSomething',
                    origin: 'application',
                    params: undefined,
                    status: 'ok',
                    start: now,
                    end: now,
                    done: jasmine.any(Function),
                    fail: jasmine.any(Function),
                    waitForCompletion: jasmine.any(Function),
                });
                const activities = service.getActivitiesInProcess();
                expect(activities.length).toEqual(0);
                done();
            });
        activity.done();
    });

    it('activity fail method should complete activity', (done) => {
        const activity = service.registerNewActivity('doSomething');

        activity.waitForCompletion()
            .then(() => {
                expect(activity).toEqual({
                    call: 'doSomething',
                    origin: 'application',
                    params: undefined,
                    status: 'error',
                    start: now,
                    end: now,
                    error: 'bad error',
                    done: jasmine.any(Function),
                    fail: jasmine.any(Function),
                    waitForCompletion: jasmine.any(Function),
                });
                const activities = service.getActivitiesInProcess();
                expect(activities.length).toEqual(0);
                done();
            });
        activity.fail('bad error');
    });


    it('getActivitiesInProcess should return list of activities in progress', async () => {
        const activity1 = service.registerNewActivity('doSomething');
        const activity2 = service.registerNewActivity('doSomething2');
        const activity3 = service.registerNewActivity('doSomething3');
        activity2.done();
        await activity2.waitForCompletion();
        const activities = service.getActivitiesInProcess();
        expect(activities.length).toEqual(2);
        expect(activities).toEqual([
            activity1,
            activity3
        ]);
    });

    it('pause function should execute in 10s and returns when all activies complete', (done) => {
        const activity1 = service.registerNewActivity('doSomething');
        const activity2 = service.registerNewActivity('doSomething2');

        service.pause().then(() => {
            const activities = service.getActivitiesInProcess();
            expect(activities.length).toEqual(0);
            done();
        });
        activity1.done();
        activity2.done();
        jasmine.clock().tick(11 * 1000);
    });

    it('pause function should execute after a specific delay', (done) => {
        const activity1 = service.registerNewActivity('doSomething');
        const activity2 = service.registerNewActivity('doSomething2');

        service.pause(60).then(() => {
            const activities = service.getActivitiesInProcess();
            expect(activities.length).toEqual(0);
            done();
        });
        jasmine.clock().tick(10 * 1000);
        activity1.done();
        activity2.done();
        jasmine.clock().tick(51 * 1000);
    });

    it('isServerPaused should return true is server is entering in pause', (done) => {
        const activity1 = service.registerNewActivity('doSomething');
        const activity2 = service.registerNewActivity('doSomething2');
        expect(service.isServerPaused()).toBe(false);
        service.pause().then(() => {
            const activities = service.getActivitiesInProcess();
            expect(activities.length).toEqual(0);
            done();
        });
        expect(service.isServerPaused()).toBe(true);
        activity1.done();
        activity2.done();
        jasmine.clock().tick(11 * 1000);
    });
});
