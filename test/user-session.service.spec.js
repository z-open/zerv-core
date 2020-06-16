'use strict';
const moment = require('moment');
const _ = require('lodash');
const UUID = require('uuid');
const zerv = require('../lib/zerv-core');
const service = require('../lib/user-session.service');
const tokenBlacklistService = require('../lib/token-blacklist.service');
const { getLocalUserSessions, logout } = require('../lib/user-session.service');
const redisService = require('../lib/redis.service');

describe('user-session.service', () => {
    let io;
    let socketForUser01, socket2ForUser01, socketForUser02, socketForUser03;
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

        socketForUser01 = {
            id: 'socketId',
            userId: 'user01',
            origin: 'browserId01',
            tenantId: 'corpPlus',
            token: 'user01Token',
            payload: '12345678',
            creation: '02/01/2020',
            server: io,
            connected: true,
            emit: jasmine.createSpy('socketForUser01.emit')
        };
        socket2ForUser01 = {
            id: 'socketId2',
            userId: 'user01',
            origin: 'browserId01',
            tenantId: 'corpPlus',
            token: 'user01Token2', 
            payload: '12345678',
            creation: '02/01/2020',
            server: io,
            connected: true,
            emit: jasmine.createSpy('socket2ForUser01.emit')
        };

        socketForUser02 = {
            id: 'socketId02',
            userId: 'user02',
            origin: 'browserId02',
            tenantId: 'corpPlus',
            token: 'user02Token',
            payload: '12348',
            creation: '02/01/2020',
            server: io,
            connected: true,
            emit: jasmine.createSpy('socketForUser02.emit')
        };

        socketForUser03 = {
            id: 'socketId03',
            userId: 'user03',
            origin: 'browserId03',
            tenantId: 'corpPlus',
            token: 'user03Token',
            payload: '12348',
            creation: '02/01/2020',
            server: io,
            connected: true,
            emit: jasmine.createSpy('socketForUser03.emit')
        };

        io.sockets.sockets = [socketForUser01];

        const zervSync = {
            publish: _.noop,
            notifyCreation: _.noop,
            notifyDelete: _.noop,
            onChanges: jasmine.createSpy('onChanges')
        };

        zervWithSyncModule = _.assign(zervSync, zerv);
        spyOn(zervSync, 'publish');
        spyOn(zervSync, 'notifyCreation');
        spyOn(zervSync, 'notifyDelete');


        serverInstanceId = 'idCreatedAtLaunch';
        spyOn(service, 'getServerInstanceId').and.returnValue(serverInstanceId);

        spyOn(redisService, 'isRedisEnabled').and.returnValue(true);
        spyOn(redisService, 'getRedisClient').and.returnValue({
            setex: jasmine.createSpy('getRedisClient.setEx').and.returnValues(Promise.resolve()),
            del: jasmine.createSpy('getRedisClient.del').and.returnValues(Promise.resolve()),
            get: jasmine.createSpy('getRedisClient.get').and.returnValues(Promise.resolve())
        });

        spyOn(UUID, 'v4').and.returnValue('aUuid');
    });

    afterEach(() => {
        service._clearOldUserSessionsInterval();
        jasmine.clock().uninstall();
    });
    describe('connectUser function', () => {
        beforeEach(() => {
            spyOn(service, '_scheduleUserSessionMaintenance');
        });

        it('should creates a new local session only', async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            service.init(zerv, io, 2);
            io.sockets.sockets = [socketForUser01];
            await service.connectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            expect(sessions.length).toEqual(1);
            expect(sessions[0].toJSON()).toEqual(
                {
                    id: jasmine.any(String),
                    userId: 'user01',
                    origin: 'browserId01',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: now,
                    payload: '12345678',
                    revision: 0,
                    lastUpdate: now,
                    active: true,
                    firstName: undefined,
                    lastName: undefined,
                    maxActiveDuration: 720,
                    clusterCreation: null,
                    clusterUserSessionId: null,
                    connections: 1
                }
            );
        });

        it('should creates a local session belonging to a cluster', async () => {
            service.init(zerv, io, 2);
            io.sockets.sockets = [socketForUser01];
            await service.connectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            expect(sessions.length).toEqual(1);
            expect(sessions[0].toJSON()).toEqual(
                {
                    id: jasmine.any(String),
                    userId: 'user01',
                    origin: 'browserId01',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: now,
                    payload: '12345678',
                    revision: 0,
                    lastUpdate: now,
                    active: true,
                    firstName: undefined,
                    lastName: undefined,
                    maxActiveDuration: 720,
                    clusterCreation: now,
                    clusterUserSessionId: jasmine.any(String),
                    connections: 1
                }
            );
            expect(redisService.getRedisClient().setex).toHaveBeenCalledWith(
                'SESSION_browserId01', 
                43200,
                '{"clusterUserSessionId":"aUuid","userId":"user01","origin":"browserId01","tenantId":"corpPlus","clusterCreation":"2020-02-06T10:06:07.000Z","maxActiveDuration":720}'
            );
        });

        it('should create a new session that notifies via zerv sync', async () => {
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01];
            await service.connectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            const expectedSession = sessions[0];

            expect(zervWithSyncModule.publish).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledWith(
                'corpPlus',
                'USER_SESSION',
                expectedSession
            );
            expect(zervWithSyncModule.notifyDelete).toHaveBeenCalledTimes(0);
        });

        it('should not create a new session but increase number of connections to the existing one', async () => {
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01];
            const session = await service.connectUser(socketForUser01);
            expect(session.connections).toEqual(1);
            io.sockets.sockets = [socketForUser01, socket2ForUser01];
            service.connectUser(socket2ForUser01);
            expect(session.connections).toEqual(2);
        });
    });

    describe('disconnectUser function', () => {

        beforeEach(() => {
            spyOn(service, '_scheduleUserSessionMaintenance');
        });

        it('should disconnect an existing session and set it inactive', async () => {
            redisService.isRedisEnabled.and.returnValue(false);

            service.init(zerv, io, 2);
            io.sockets.sockets = [socketForUser01];
            await service.connectUser(socketForUser01);
            socketForUser01.connected = false;
            const beforeNow = now;
            jasmine.clock().tick(10000);
            now = new Date();
            await service.disconnectUser(socketForUser01);

            const sessions = service.getLocalUserSessions();
            expect(sessions.length).toEqual(1);
            expect(sessions[0].toJSON()).toEqual(
                {
                    id: jasmine.any(String),
                    userId: 'user01',
                    origin: 'browserId01',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: beforeNow,
                    payload: '12345678',
                    revision: 1,
                    lastUpdate: now,
                    active: false,
                    firstName: undefined,
                    lastName: undefined,
                    maxActiveDuration: 720,
                    clusterCreation: null,
                    clusterUserSessionId: null,
                    connections: 0
                }
            );            
        });

        it('should disconnect an existing session but NOT notify any user session removal', async () => {
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01];
            await service.connectUser(socketForUser01);
            socketForUser01.connected = false;
            jasmine.clock().tick(10000);
            await service.disconnectUser(socketForUser01);
            expect(zervWithSyncModule.notifyDelete).not.toHaveBeenCalled();
        });

        it('should NOT disconnect an existing session but keep it active and reduce the number of connections', async () => {
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01];
            const session = await service.connectUser(socketForUser01);
            io.sockets.sockets = [socketForUser01, socket2ForUser01];
            await service.connectUser(socket2ForUser01);
            expect(session.connections).toEqual(2);

            socketForUser01.connected = false;
            jasmine.clock().tick(10000);
            await service.disconnectUser(socketForUser01);
            expect(session.active).toBeTrue();
            expect(session.connections).toEqual(1);
        });
    });


    describe('_removeAllInactiveLocalUserSessions function', () => {

        beforeEach(() => {
            spyOn(service, '_scheduleUserSessionMaintenance');
        });

        it('should remove inactive local session that has been inactive for sometime', async () => {
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01, socketForUser02];
            await service.connectUser(socketForUser01);
            await service.connectUser(socketForUser02);
            //jasmine.clock().tick(50 * 60000);
            io.sockets.sockets = [socketForUser02];
            // one disconnect 
            await service.disconnectUser(socketForUser01);
            jasmine.clock().tick(50 * 60000);
            io.sockets.sockets = [socketForUser02, socketForUser03];
            await service.connectUser(socketForUser03);
            jasmine.clock().tick(10000);
            // another has just disconnected
            io.sockets.sockets = [socketForUser02];
            await service.disconnectUser(socketForUser03);
            service._removeAllInactiveLocalUserSessions(40);
            expect(service.getLocalUserSessions().length).toBe(2);
        });

        it('should schedule the removal of inactive session', () => {

        });
        //code logout, m...socketForUser03.

    });

    describe('_logoutLocally function', () => {
        let localUserSession, localUser02Session;
        beforeEach(async () => {
            spyOn(service, '_removeLocalUserSession');
            spyOn(tokenBlacklistService, 'blacklistToken');

            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01, socketForUser02, socket2ForUser01];
            await service.connectUser(socketForUser01);

            const sessions = service.getLocalUserSessions();
            expect(sessions.length).toEqual(1);
            localUserSession = sessions[0];
            localUser02Session = sessions[1];
        });

        it('should remove the local user session from memory', async () => {
            expect(localUserSession.active).toBeTrue();
            await service._logoutLocally(localUserSession, 'logout_test');
            expect(service._removeLocalUserSession).toHaveBeenCalledWith(localUserSession, 'logout_test');
            expect(localUserSession.active).toBeFalse();
        });

        it('should log out all sockets related to the logged out session and blacklist their token to prevent reuse', async () => {
            await service._logoutLocally(localUserSession, 'logout_test');
            expect(socketForUser01.emit).toHaveBeenCalledWith('logged_out', 'logout_test');
            expect(tokenBlacklistService.blacklistToken).toHaveBeenCalledWith('user01Token');
            expect(socket2ForUser01.emit).toHaveBeenCalledWith('logged_out', 'logout_test');
            expect(tokenBlacklistService.blacklistToken).toHaveBeenCalledWith('user01Token2');
        });

        it('should NOT logout sockets or blacklist tokens of other user sessions', async () => {
            await service._logoutLocally(localUserSession, 'logout_test');
            expect(service._removeLocalUserSession).not.toHaveBeenCalledWith(localUser02Session, 'logout_test');
            expect(socketForUser02.emit).not.toHaveBeenCalled();
            expect(tokenBlacklistService.blacklistToken).not.toHaveBeenCalledWith(socketForUser02.token);
        });

        it('should delete the cluster session when redis is enabled', async () => {
            await service._logoutLocally(localUserSession, 'logout_test');
            expect(redisService.getRedisClient).toHaveBeenCalled();
            expect(redisService.getRedisClient().del).toHaveBeenCalledWith('SESSION_browserId01');
        });

        it('should NOT delete the cluster session when redis is disabled', async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            await service._logoutLocally(localUserSession, 'logout_test');
            expect(redisService.getRedisClient().del).not.toHaveBeenCalled();
        });
    });

    xdescribe('createUserSessionEventHandler function', () => {
        it('connectUser function creates a new session', () => {
            const eventHandler = service.init(zerv, io, 2);
            eventHandler.connectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            expect(sessions).toEqual([
                {
                    id: 'socketId',
                    userId: 'user01',
                    origin: 'browserId01',
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

        it('connectUser creates a new session that notifies via zerv sync', () => {
            const eventHandler = service.createUserSessionEventHandler(zervWithSyncModule, io, 2, null, null);
            eventHandler.connectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            const expectedSession = {
                id: 'socketId',
                userId: 'user01',
                origin: 'browserId01',
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

        it('returns handler whose disconnectUser disconnect an existing session', () => {
            const eventHandler = service.createUserSessionEventHandler(zerv, io, 2, null, null);
            eventHandler.connectUser(socketForUser01);
            jasmine.clock().tick(10000);
            now = new Date();
            eventHandler.disconnectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            expect(sessions).toEqual([
                {
                    id: 'socketId',
                    userId: 'user01',
                    origin: 'browserId01',
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


        it('returns handler whose disconnectUser disconnect an existing session', () => {
            const eventHandler = service.createUserSessionEventHandler(zervWithSyncModule, io, 2, null, null);
            eventHandler.connectUser(socketForUser01);
            jasmine.clock().tick(10000);
            now = new Date();
            eventHandler.disconnectUser(socketForUser01);
            const sessions = service.getLocalUserSessions();
            const expectedInactiveSession = {
                id: 'socketId',
                userId: 'user01',
                origin: 'browserId01',
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

            eventHandler.connectUser(socketForUser01);
            jasmine.clock().tick(10000);
            now = new Date();

            eventHandler.disconnectUser(socketForUser01);
            let sessions = service.getLocalUserSessions();
            expect(sessions.length).toBe(1);
            expect(sessions).toEqual([
                {
                    id: 'socketId',
                    userId: 'user01',
                    origin: 'browserId01',
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
