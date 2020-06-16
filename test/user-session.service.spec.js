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

    });

    afterEach(() => {
        service._clearOldUserSessionsInterval();
        jasmine.clock().uninstall();
    });
    describe('connectUser function', () => {
        beforeEach(() => {
            spyOn(service, '_scheduleUserSessionMaintenance');
            spyOn(service, '_scheduleAutoLogout');
        });

        it('should creates a new local session only', async () => {
            redisService.isRedisEnabled.and.returnValue(false);
            service.init(zerv, io, 2);
            io.sockets.sockets = [socketForUser01];
            const localUserSession = await service.connectUser(socketForUser01);
            expect(service.getLocalUserSessions()).toEqual([localUserSession]);
            expect(localUserSession.toJSON()).toEqual(
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
            expect(service._scheduleAutoLogout).toHaveBeenCalledWith(localUserSession);
        });

        it('should creates a local session belonging to a cluster', async () => {
            spyOn(UUID, 'v4').and.returnValue('aUuid');
            service.init(zerv, io, 2);
            io.sockets.sockets = [socketForUser01];
            const localUserSession = await service.connectUser(socketForUser01);
            expect(service.getLocalUserSessions()).toEqual([localUserSession]);
            expect(localUserSession.toJSON()).toEqual(
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
            const localUserSession = await service.connectUser(socketForUser01);

            expect(zervWithSyncModule.publish).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledWith(
                'corpPlus',
                'USER_SESSION',
                localUserSession
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

    describe('_scheduleAutoLogout function', () => {
        let localUser01Session;
        beforeEach(() => {
            spyOn(service, '_scheduleAutoLogout').and.callThrough();
            spyOn(service, 'logout');
            redisService.isRedisEnabled.and.returnValue(true);
            service.init(zerv, io, 2);
            io.sockets.sockets = [socketForUser01];
        });

        it('should auto log out user session based on maximum session timeout', async () => {
            service.setTenantMaximumActiveSessionTimeout(socketForUser01.tenantId, 7);
            localUser01Session = await service.connectUser(socketForUser01);
            expect(service._scheduleAutoLogout).toHaveBeenCalledWith(localUser01Session);

            expect(localUser01Session.getRemainingTimeInSecs()).toEqual(420);
            jasmine.clock().tick(3 * 60000);
            expect(localUser01Session.getRemainingTimeInSecs()).toEqual(240);
            expect(service.logout).not.toHaveBeenCalled();
            jasmine.clock().tick(4 * 60000);
            expect(localUser01Session.getRemainingTimeInSecs()).toEqual(0);
            expect(service.logout).toHaveBeenCalledWith(localUser01Session.origin, 'session_timeout');
        });

        it('should auto log out the user session as the cluster session has already expired', async () => {
            const _getClusterUserSession = service._getClusterUserSession;
            spyOn(service, '_getClusterUserSession').and.callFake(async (localUserSession) => {
                const clusterSession = await _getClusterUserSession(localUserSession);
                clusterSession.clusterCreation = moment().add(-30, 'minutes').toDate();
                return clusterSession;
            })
            service.setTenantMaximumActiveSessionTimeout(socketForUser01.tenantId, 7);
            localUser01Session = await service.connectUser(socketForUser01);
            expect(service._scheduleAutoLogout).toHaveBeenCalledWith(localUser01Session);
            expect(localUser01Session.getRemainingTimeInSecs()).toEqual(0);
            expect(service.logout).toHaveBeenCalledWith(localUser01Session.origin, 'session_timeout');

        });

    })

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

    describe('_handleLogoutNotification function', () => {

        let localUserSession, localUser02Session;

        beforeEach(async () => {
            spyOn(service, '_logoutLocally');
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01, socketForUser02];
            localUserSession = await service.connectUser(socketForUser01);
            localUser02Session = await service.connectUser(socketForUser02);
        });

        it('should be set up if sync lib is used', () => {
            expect(zervWithSyncModule.onChanges).toHaveBeenCalledWith('USER_SESSION_LOGGED_OUT', service._handleLogoutNotification);
        });

        it('should log an existing session out if server is not the origin of the notification', () => {
            service._handleLogoutNotification('not used', {
                id: 'usedForZervInternalPublicationMechanism',
                origin: socketForUser01.origin,
                logoutReason: 'notif_test',
                zervServerId: 'serverThatOriginatedLogout'
            });
            expect(service._logoutLocally).toHaveBeenCalledWith(localUserSession, 'notif_test');
        });

        it('should request logging out an existing session out if server is the origin of the notification', () => {
            service._handleLogoutNotification('not used', {
                id: 'usedForZervInternalPublicationMechanism',
                origin: socketForUser01.origin,
                logoutReason: 'notif_test',
                zervServerId: serverInstanceId
            });
            expect(service._logoutLocally).not.toHaveBeenCalled();
        });

        it('should not logout anything if session does not exist on the server', () => {
            service._handleLogoutNotification('not used', {
                id: 'usedForZervInternalPublicationMechanism',
                origin: 'aBrowserSessionNotHandledByThisServer',
                logoutReason: 'notif_test',
                zervServerId: serverInstanceId
            });
            expect(service._logoutLocally).not.toHaveBeenCalled();
        });
    });

    describe('_logoutLocally function', () => {
        let localUserSession, localUser02Session;
        beforeEach(async () => {
            spyOn(service, '_destroyLocalUserSession');
            spyOn(tokenBlacklistService, 'blacklistToken');

            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01, socketForUser02, socket2ForUser01];
            localUserSession = await service.connectUser(socketForUser01);
            await service.connectUser(socket2ForUser01);
            localUser02Session = await service.connectUser(socketForUser02);

            const sessions = service.getLocalUserSessions();
            expect(sessions.length).toEqual(2);
        });

        it('should remove the local user session from memory', async () => {
            expect(localUserSession.active).toBeTrue();
            await service._logoutLocally(localUserSession, 'logout_test');
            expect(service._destroyLocalUserSession).toHaveBeenCalledWith(localUserSession, 'logout_test');
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
            expect(service._destroyLocalUserSession).not.toHaveBeenCalledWith(localUser02Session, 'logout_test');
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

    describe('_destroyLocalUserSession function', () => {
        let localUserSession, localUser02Session;
        beforeEach(async () => {
            spyOn(service, '_notifyLocalUserSessionDestroy');
            service.init(zervWithSyncModule, io, 2);
            io.sockets.sockets = [socketForUser01, socketForUser02, socket2ForUser01];
            localUserSession = await service.connectUser(socketForUser01);
            await service.connectUser(socket2ForUser01);
            localUser02Session = await service.connectUser(socketForUser02);

            const sessions = service.getLocalUserSessions();
            expect(sessions.length).toEqual(2);
        });
        it('should remove from memory', () => {
            service._destroyLocalUserSession(localUserSession, 'destroy_test');
            expect(localUserSession.active).toEqual(false);
            expect(service.getLocalUserSession(localUserSession.origin)).toBeUndefined();
            expect(service.getLocalUserSession(localUser02Session.origin)).toBe(localUser02Session);
        });

        it('should notify destroy listeners and session deletion', () => {
            expect(localUserSession.timeout).toEqual(jasmine.anything());
            service._destroyLocalUserSession(localUserSession, 'destroy_test');
            expect(localUserSession.timeout).toBeNull();
            expect(service._notifyLocalUserSessionDestroy).toHaveBeenCalledTimes(1);
            expect(service._notifyLocalUserSessionDestroy).toHaveBeenCalledWith(localUserSession, 'destroy_test');
            expect(zervWithSyncModule.notifyDelete).toHaveBeenCalledWith(localUserSession.tenantId, 'USER_SESSION', localUserSession);
        });

        it('should not notify the session removal', () => {
            zervWithSyncModule.publish = null;
            service._destroyLocalUserSession(localUserSession, 'destroy_test');
            expect(zervWithSyncModule.notifyDelete).not.toHaveBeenCalled();
        });
    });

    describe('logout function', () => {

        let localUserSession;

        beforeEach(async () => {
            spyOn(service, '_logoutLocally');
            localUserSession = {
                id:'aSession',
                tenantId: 'corpPlus',
                origin: 'browserOriginId',
                zervServerId: 'thisServer'
            };
            spyOn(service, 'getLocalUserSession').and.returnValue(localUserSession);
        });

        it('should log out the session at the origin provided and notify to other servers', async () => {
            service.init(zervWithSyncModule, io, 2);
            await service.logout(localUserSession.origin, 'logout_test');
            expect(service._logoutLocally).toHaveBeenCalledWith(localUserSession, 'logout_test');

            expect(zervWithSyncModule.publish).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledWith(
                'corpPlus',
                'USER_SESSION_LOGGED_OUT',
                { id: 1580983567000, origin: 'browserOriginId', logoutReason: 'logout_test', zervServerId: 'thisServer' },
                { allServers: true }
            );
        });

        it('should log out the session at the origin provided and NOT notify when sync module is not used', async () => {
            service.init(zerv, io, 2);
            await service.logout(localUserSession.origin, 'logout_test');
            expect(service._logoutLocally).toHaveBeenCalledWith(localUserSession, 'logout_test');
            expect(zervWithSyncModule.publish).not.toHaveBeenCalled();
            expect(zervWithSyncModule.notifyCreation).not.toHaveBeenCalled();
        });

    });

    describe('tenantMaximumActiveSessionTimeout value', () => {
        it('should be set and retrieve properly', () => {
            service.setTenantMaximumActiveSessionTimeout('prudentTenantId', 60);
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('prudentTenantId')).toEqual(60);
        });

        it('should be a default value for invalid value', () => {
            service.setTenantMaximumActiveSessionTimeout('aTenant', -5);
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('aTenant')).toEqual(720);
        });
        
        it('should be a default value for inexisting tenant', () => {
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('carelessTenantId')).toEqual(720);
        });
    });

    describe('localSessionDestroy listener', () => {

        let localUserSession;

        beforeEach(async () => {
            localUserSession = {
                id:'aSession',
                tenantId: 'corpPlus',
                origin: 'browserOriginId',
                zervServerId: 'thisServer'
            };
        });

        it('should be set with a callback', () => {
            const callback = jasmine.createSpy('destroyCallback');
            const off = service.onLocalUserSessionDestroy(callback);
            const callback2 = jasmine.createSpy('destroyCallback2');
            const off2 = service.onLocalUserSessionDestroy(callback2);
            service._notifyLocalUserSessionDestroy(localUserSession, 'logout_test');
            expect(callback).toHaveBeenCalledWith(localUserSession, 'logout_test');
            expect(callback2).toHaveBeenCalledWith(localUserSession, 'logout_test');
            off();
            off2();
        });

        it('should remove the callback', () => {
            const callback = jasmine.createSpy('destroyCallback');
            const off = service.onLocalUserSessionDestroy(callback);
            off();
            const callback2 = jasmine.createSpy('destroyCallback2');
            const off2 = service.onLocalUserSessionDestroy(callback2);
            service._notifyLocalUserSessionDestroy(localUserSession, 'logout_test');
            expect(callback).not.toHaveBeenCalled();
            expect(callback2).toHaveBeenCalledWith(localUserSession, 'logout_test');
            off2();
        });
    })
});
