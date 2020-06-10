'use strict';
const moment = require('moment');
const _ = require('lodash');
const zerv = require('../lib/zerv-core');
const service = require('../lib/user-session.service');

describe('user-session.service', () => {
    let io;
    let socket;
    let now;
    let serverInstanceId;
    let zervWithSyncModule;

    beforeEach(() => {
        now = moment('Feb 6 2020 05:06:07', 'MMM DD YYYY hh:mm:ss').toDate();
        jasmine.clock().install();
        jasmine.clock().mockDate(now);

        io = {
            sockets: {
                sockets: []
            }
        };

        socket = {
            id: 'socketId',
            userId: 'user23',
            origin: 'browserId3',
            tenantId: 'corpPlus',
            payload: '12345678',
            creation: '02/01/2020',
            server: io,
            emit: _.noop
        };

        io.sockets.sockets = [socket];

        const zervSync = {
            publish: _.noop,
            notifyCreation: _.noop,
            notifyDelete: _.noop,
        };
        zervWithSyncModule = _.assign(zervSync, zerv);
        spyOn(zervSync, 'publish');
        spyOn(zervSync, 'notifyCreation');
        spyOn(zervSync, 'notifyDelete');

        serverInstanceId = 'idCreatedAtLaunch';
        spyOn(service, 'getServerInstanceId').and.returnValue(serverInstanceId);
    });

    afterEach(() => {
        service._clearOldUserSessionsInterval();
        jasmine.clock().uninstall();
    });

    describe('createUserSessionEventHandler function', () => {
        it('onUserConnect function creates a new session', () => {
            const eventHandler = service.createUserSessionEventHandler(zerv, io, 2, null, null);
            eventHandler.onUserConnect(socket);
            const sessions = service.getLocalUserSessions();
            expect(sessions).toEqual([
                {
                    id: 'socketId',
                    userId: 'user23',
                    origin: 'browserId3',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: '02/01/2020',
                    payload: '12345678',
                    revision: 0,
                    lastUpdate: now,
                    active: true
                }
            ]);
        });

        it('onUserConnect creates a new session that notifies via zerv sync', () => {
            const eventHandler = service.createUserSessionEventHandler(zervWithSyncModule, io, 2, null, null);
            eventHandler.onUserConnect(socket);
            const sessions = service.getLocalUserSessions();
            const expectedSession = {
                id: 'socketId',
                userId: 'user23',
                origin: 'browserId3',
                zervServerId: serverInstanceId,
                tenantId: 'corpPlus',
                creation: '02/01/2020',
                payload: '12345678',
                revision: 0,
                lastUpdate: now,
                active: true
            };
            expect(sessions).toEqual([
                expectedSession
            ]);

            expect(zervWithSyncModule.publish).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledWith(
                'corpPlus',
                'USER_SESSION',
                expectedSession
            );
            expect(zervWithSyncModule.notifyDelete).toHaveBeenCalledTimes(0);
        });

        it('returns handler whose onUserDisconnect disconnect an existing session', () => {
            const eventHandler = service.createUserSessionEventHandler(zerv, io, 2, null, null);
            eventHandler.onUserConnect(socket);
            jasmine.clock().tick(10000);
            now = new Date();
            eventHandler.onUserDisconnect(socket);
            const sessions = service.getLocalUserSessions();
            expect(sessions).toEqual([
                {
                    id: 'socketId',
                    userId: 'user23',
                    origin: 'browserId3',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: '02/01/2020',
                    payload: '12345678',
                    revision: 1,
                    lastUpdate: now,
                    active: false
                }
            ]);
        });


        it('returns handler whose onUserDisconnect disconnect an existing session', () => {
            const eventHandler = service.createUserSessionEventHandler(zervWithSyncModule, io, 2, null, null);
            eventHandler.onUserConnect(socket);
            jasmine.clock().tick(10000);
            now = new Date();
            eventHandler.onUserDisconnect(socket);
            const sessions = service.getLocalUserSessions();
            const expectedInactiveSession = {
                id: 'socketId',
                userId: 'user23',
                origin: 'browserId3',
                zervServerId: serverInstanceId,
                tenantId: 'corpPlus',
                creation: '02/01/2020',
                payload: '12345678',
                revision: 1,
                lastUpdate: now,
                active: false
            };

            expect(sessions).toEqual([
                expectedInactiveSession
            ]);
            expect(zervWithSyncModule.publish).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyDelete).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyDelete).toHaveBeenCalledWith(
                    'corpPlus',
                    'USER_SESSION',
                    expectedInactiveSession
            );
        });


        it('returns handler that will release inactive expired user session from memory on an interval basis', () => {
            spyOn(service, '_clearOldUserSessions').and.callThrough();
            const eventHandler = service.createUserSessionEventHandler(zerv, io, 2, null, null);

            eventHandler.onUserConnect(socket);
            jasmine.clock().tick(10000);
            now = new Date();

            eventHandler.onUserDisconnect(socket);
            let sessions = service.getLocalUserSessions();
            expect(sessions.length).toBe(1);
            expect(sessions).toEqual([
                {
                    id: 'socketId',
                    userId: 'user23',
                    origin: 'browserId3',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: '02/01/2020',
                    payload: '12345678',
                    revision: 1,
                    lastUpdate: now,
                    active: false
                }
            ]);
            jasmine.clock().tick(2*60000);
            sessions = service.getLocalUserSessions();
            expect(service._clearOldUserSessions).toHaveBeenCalledTimes(1);
            expect(sessions.length).toBe(1);
            jasmine.clock().tick(2*60000);
            sessions = service.getLocalUserSessions();
            // the 2nd time the session will be removed from memeory
            expect(service._clearOldUserSessions).toHaveBeenCalledTimes(2);
            expect(sessions.length).toBe(0);
        });
    });
});
