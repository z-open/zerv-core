'use strict';
const moment = require('moment');
const _ = require('lodash');
const UUID = require('uuid');
const zerv = require('../lib/zerv-core');
const service = require('../lib/user-session.service');
const tokenBlacklistService = require('../lib/token-blacklist.service');
const cacheService = require('../lib/cache.service');

let io;

describe('user-session.service', () => {
    let socketForUser01, socket2ForUser01, socketForUser02, socketForUser03;
    let now;
    let serverInstanceId;
    let zervWithSyncModule;
    let maxInactiveTimeInMinsForInactiveSession;

    beforeEach(() => {
        now = moment('Feb 6 2020 05:06:07', 'MMM DD YYYY hh:mm:ss').toDate();
        jasmine.clock().install();
        jasmine.clock().mockDate(now);

        maxInactiveTimeInMinsForInactiveSession = 5;

        io = {
            sockets: {
                sockets: []
            }
        };

        socketForUser01 = new MockSocket({
            id: 'socketId',
            userId: 'user01',
            origin: 'browserId01',
            tenantId: 'corpPlus',
            token: 'user01Token',
            payload: {firstName: 'Luke', lastName: 'John'}, // decoded token is fake here.
            creation: '02/01/2020',
            server: io,
        });

        socket2ForUser01 = new MockSocket({
            id: 'socketId2',
            userId: 'user01',
            origin: 'browserId01',
            tenantId: 'corpPlus',
            token: 'user01Token2',
            payload: {firstName: 'Luke', lastName: 'John'},
            creation: '02/01/2020',
            server: io,
            connected: true,
            emit: jasmine.createSpy('socket2ForUser01.emit')
        });

        socketForUser02 = new MockSocket({
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
        });

        socketForUser03 = new MockSocket({
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
        });

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

        spyOn(cacheService, 'isClusterCacheEnabled').and.returnValue(true);
        spyOn(cacheService, 'cacheData').and.returnValue(Promise.resolve());
        spyOn(cacheService, 'removeCachedData').and.returnValue(Promise.resolve());
        spyOn(cacheService, 'getCachedObject').and.returnValue(Promise.resolve());
    });

    afterEach(() => {
        service._clearOldUserSessionsInterval();
        jasmine.clock().uninstall();
    });

    describe('init function', () => {
        it('should schedule the user session maintenance', () => {
            spyOn(service, '_scheduleUserSessionMaintenance');
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            expect(service._scheduleUserSessionMaintenance).toHaveBeenCalledWith(maxInactiveTimeInMinsForInactiveSession);
        });

        it('should publish the local session user and listen to logout event from other servers', () => {
            spyOn(service, '_scheduleUserSessionMaintenance');
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            expect(zervWithSyncModule.onChanges).toHaveBeenCalledWith('USER_SESSION_LOGGED_OUT', service._handleLogoutNotification);
            expect(zervWithSyncModule.publish).toHaveBeenCalledWith( 'user-sessions.sync', jasmine.any(Function), 'USER_SESSION');
        });

        it('should NOT publish the local session user and listen to logout event from other servers', () => {
            spyOn(service, '_scheduleUserSessionMaintenance');
            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
            expect(zerv.onChanges).toBeUndefined();
            expect(zerv.publish).toBeUndefined();
        });
    });

    describe('_scheduleUserSessionMaintenance function', () => {
        it('should delete inactive session after a time of inactivity', async () => {
            spyOn(service, '_destroyLocalUserSession');
            spyOn(service, '_removeAllInactiveLocalUserSessions').and.callThrough();
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            await socketForUser01.connect();
            const localUser01Session = socketForUser01.localUserSession;
            await socketForUser02.connect();

            jasmine.clock().tick(1 * 60000);
            await socketForUser01.disconnect();
            expect(service._destroyLocalUserSession).not.toHaveBeenCalled();
            expect(service._removeAllInactiveLocalUserSessions).not.toHaveBeenCalled();
            jasmine.clock().tick(6 * 60000);
            expect(service._removeAllInactiveLocalUserSessions).toHaveBeenCalled();
            expect(service._destroyLocalUserSession).not.toHaveBeenCalled();
            jasmine.clock().tick(6 * 60000);
            expect(service._removeAllInactiveLocalUserSessions).toHaveBeenCalled();
            expect(service._destroyLocalUserSession).toHaveBeenCalledTimes(1);
            expect(service._destroyLocalUserSession).toHaveBeenCalledWith(localUser01Session, 'garbage_collected');
        });
    });


    describe('connectUser function', () => {
        beforeEach(() => {
            spyOn(service, '_scheduleUserSessionMaintenance');
            spyOn(service, '_scheduleAutoLogout');
        });

        it('should creates a new local session only', async () => {
            cacheService.isClusterCacheEnabled.and.returnValue(false);
            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
            io.sockets.sockets = [socketForUser01];
            const localUserSession = await service.connectUser(socketForUser01);
            expect(socketForUser01.localUserSession).toBe(localUserSession);
            expect(service.getLocalUserSessions()).toEqual([localUserSession]);
            expect(localUserSession.toJSON()).toEqual(
                {
                    id: jasmine.any(String),
                    userId: 'user01',
                    origin: 'browserId01',
                    zervServerId: serverInstanceId,
                    tenantId: 'corpPlus',
                    creation: now,
                    payload: {firstName: 'Luke', lastName: 'John'},
                    revision: 0,
                    lastUpdate: now,
                    active: true,
                    firstName: 'Luke',
                    lastName: 'John',
                    maxActiveDuration: 129600,
                    clusterCreation: null,
                    clusterUserSessionId: null,
                    connections: 1
                }
            );
            expect(service._scheduleAutoLogout).toHaveBeenCalledWith(localUserSession);
        });

        it('should creates a local session belonging to a cluster', async () => {
            spyOn(UUID, 'v4').and.returnValue('aUuid');
            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
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
                    payload: {firstName: 'Luke', lastName: 'John'},
                    revision: 0,
                    lastUpdate: now,
                    active: true,
                    firstName: 'Luke',
                    lastName: 'John',
                    maxActiveDuration: 129600,
                    clusterCreation: now,
                    clusterUserSessionId: 'aUuid',
                    connections: 1
                }
            );
            expect(cacheService.cacheData).toHaveBeenCalledWith(
                'browserId01',
                {'clusterUserSessionId': 'aUuid', 'userId': 'user01', 'origin': 'browserId01', 'tenantId': 'corpPlus', 'clusterCreation': now, 'firstName': 'Luke', 'lastName': 'John', 'maxActiveDuration': 129600},
                {prefix: 'SESSION_', expirationInMins: 129600}
            );
        });

        it('should reuse an existing cluster session and pick up the remaining active session time', async () => {
            const clusterCreation = moment().add(-600, 'minutes').toDate();
            cacheService.getCachedObject.and.returnValue( {
                clusterUserSessionId: 'existingUuid',
                userId: 'user01',
                origin: 'browserId01',
                tenantId: 'corpPlus',
                clusterCreation,
                firstName: 'Luke',
                lastName: 'John',
                maxActiveDuration: 129600
            });
            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
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
                    payload: {firstName: 'Luke', lastName: 'John'},
                    revision: 0,
                    lastUpdate: now,
                    active: true,
                    firstName: 'Luke',
                    lastName: 'John',
                    maxActiveDuration: 129600,
                    clusterCreation,
                    clusterUserSessionId: 'existingUuid',
                    connections: 1
                }
            );
            expect(cacheService.cacheData).not.toHaveBeenCalled();
            expect(service._scheduleAutoLogout).toHaveBeenCalledWith(localUserSession);
        });

        it('should create a new session that notifies via zerv sync', async () => {
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
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
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
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
            cacheService.isClusterCacheEnabled.and.returnValue(false);

            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
            await socketForUser01.connect();
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
                    payload: {firstName: 'Luke', lastName: 'John'},
                    revision: 1,
                    lastUpdate: now,
                    active: false,
                    firstName: 'Luke',
                    lastName: 'John',
                    maxActiveDuration: 129600,
                    clusterCreation: null,
                    clusterUserSessionId: null,
                    connections: 0
                }
            );
        });

        it('should disconnect an existing session but NOT notify any user session removal', async () => {
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            await socketForUser01.connect();
            jasmine.clock().tick(10000);
            socketForUser01.connected = false;
            await service.disconnectUser(socketForUser01);
            expect(zervWithSyncModule.notifyDelete).not.toHaveBeenCalled();
        });

        it('should reconnect a disconnected session and update its status and timestamp', async () => {
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            await socketForUser01.connect();
            const localUser01Session = socketForUser01.localUserSession;
            jasmine.clock().tick(1000);
            await socketForUser01.disconnect();
            expect(localUser01Session.lastUpdate).toEqual(new Date());
            expect(localUser01Session.active).toBeFalse();
            jasmine.clock().tick(5000);
            await socketForUser01.connect();
            expect(localUser01Session.active).toBeTrue();
            expect(localUser01Session.connections).toBe(1);
            expect(localUser01Session.lastUpdate).toEqual(new Date());
        });

        it('should NOT disconnect an existing session but keep it active and reduce the number of connections', async () => {
            const maxInactiveTimeInMinsForInactiveSession = 2;
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            await socketForUser01.connect();
            const session = socketForUser01.localUserSession;
            await socket2ForUser01.connect();
            expect(session.connections).toEqual(2);
            socketForUser01.connected = false;
            await service.disconnectUser(socketForUser01);
            // only 10 seconds the connection has been disabled.
            jasmine.clock().tick(10000);
            expect(session.active).toBeTrue();
            expect(session.connections).toEqual(1);
        });
    });

    describe('_scheduleAutoLogout function', () => {
        let localUser01Session;
        beforeEach(() => {
            spyOn(service, '_scheduleAutoLogout').and.callThrough();
            spyOn(service, 'logout');
            cacheService.isClusterCacheEnabled.and.returnValue(true);
            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
        });

        it('should auto log out user session based on maximum session timeout', async () => {
            service.setTenantMaximumActiveSessionTimeout(socketForUser01.tenantId, 7);
            await socketForUser01.connect(socketForUser01);
            localUser01Session = socketForUser01.localUserSession;
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
            });
            service.setTenantMaximumActiveSessionTimeout(socketForUser01.tenantId, 7);
            await socketForUser01.connect(socketForUser01);
            localUser01Session = socketForUser01.localUserSession;
            expect(service._scheduleAutoLogout).toHaveBeenCalledWith(localUser01Session);
            expect(localUser01Session.getRemainingTimeInSecs()).toEqual(0);
            expect(service.logout).toHaveBeenCalledWith(localUser01Session.origin, 'session_timeout');
        });
    });

    describe('_removeAllInactiveLocalUserSessions function', () => {
        beforeEach(() => {
            spyOn(service, '_scheduleUserSessionMaintenance');
        });

        it('should remove inactive local session that has been inactive for sometime', async () => {
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            await socketForUser01.connect();
            await socketForUser02.connect();
            // jasmine.clock().tick(50 * 60000);
            io.sockets.sockets = [socketForUser02];
            // one disconnect
            await socketForUser01.disconnect();
            jasmine.clock().tick(50 * 60000);
            await socketForUser03.connect();
            jasmine.clock().tick(10000);
            // another has just disconnected
            await socketForUser03.disconnect();
            service._removeAllInactiveLocalUserSessions(40);
            expect(service.getLocalUserSessions().length).toBe(2);
        });

        it('should schedule the removal of inactive session', () => {

        });
    });

    describe('_handleLogoutNotification function', () => {
        let localUserSession;

        beforeEach(async () => {
            spyOn(service, '_logoutLocally');
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            io.sockets.sockets = [socketForUser01, socketForUser02];
            localUserSession = await service.connectUser(socketForUser01);
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
        let localUser01Session, localUser02Session;
        beforeEach(async () => {
            spyOn(service, '_destroyLocalUserSession');
            spyOn(tokenBlacklistService, 'revokeToken');

            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);

            await socketForUser01.connect();
            await socket2ForUser01.connect();
            await socketForUser02.connect();

            localUser01Session = socketForUser01.localUserSession;
            localUser02Session = socketForUser02.localUserSession;
        });

        it('should remove the local user session from memory', async () => {
            expect(localUser01Session.active).toBeTrue();
            await service._logoutLocally(localUser01Session, 'logout_test');
            expect(service._destroyLocalUserSession).toHaveBeenCalledWith(localUser01Session, 'logout_test');
            expect(localUser01Session.active).toBeFalse();
        });

        it('should log out all sockets related to the logged out session and blacklist their token to prevent reuse', async () => {
            await service._logoutLocally(localUser01Session, 'logout_test');
            expect(socketForUser01.emit).toHaveBeenCalledWith('logged_out', 'logout_test');
            expect(tokenBlacklistService.revokeToken).toHaveBeenCalledWith('user01Token');
            expect(socket2ForUser01.emit).toHaveBeenCalledWith('logged_out', 'logout_test');
            expect(tokenBlacklistService.revokeToken).toHaveBeenCalledWith('user01Token2');
        });

        it('should NOT logout sockets or blacklist tokens of other user sessions', async () => {
            await service._logoutLocally(localUser01Session, 'logout_test');
            expect(service._destroyLocalUserSession).not.toHaveBeenCalledWith(localUser02Session, 'logout_test');
            expect(socketForUser02.emit).not.toHaveBeenCalled();
            expect(tokenBlacklistService.revokeToken).not.toHaveBeenCalledWith(socketForUser02.token);
        });

        it('should delete the cluster session when redis is enabled', async () => {
            await service._logoutLocally(localUser01Session, 'logout_test');
            expect(cacheService.removeCachedData).toHaveBeenCalledWith(
                'browserId01',
                {prefix: 'SESSION_'}
            );
        });

        it('should NOT delete the cluster session when redis is disabled', async () => {
            cacheService.isClusterCacheEnabled.and.returnValue(false);
            await service._logoutLocally(localUser01Session, 'logout_test');
            expect(cacheService.removeCachedData).not.toHaveBeenCalled();
        });
    });

    describe('_destroyLocalUserSession function', () => {
        let localUser01Session, localUser02Session;
        beforeEach(async () => {
            spyOn(service, '_notifyLocalUserSessionDestroy');
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);

            await socketForUser01.connect();
            await socket2ForUser01.connect();
            await socketForUser02.connect();

            localUser01Session = socketForUser01.localUserSession;
            localUser02Session = socketForUser02.localUserSession;
        });
        it('should remove from memory', () => {
            service._destroyLocalUserSession(localUser01Session, 'destroy_test');
            expect(localUser01Session.active).toEqual(false);
            expect(service.getLocalUserSession(localUser01Session.origin)).toBeUndefined();
            expect(service.getLocalUserSession(localUser02Session.origin)).toBe(localUser02Session);
        });

        it('should notify destroy listeners and session deletion', () => {
            expect(localUser01Session.timeout).toEqual(jasmine.anything());
            service._destroyLocalUserSession(localUser01Session, 'destroy_test');
            expect(localUser01Session.timeout).toBeNull();
            expect(service._notifyLocalUserSessionDestroy).toHaveBeenCalledTimes(1);
            expect(service._notifyLocalUserSessionDestroy).toHaveBeenCalledWith(localUser01Session, 'destroy_test');
            expect(zervWithSyncModule.notifyDelete).toHaveBeenCalledWith(localUser01Session.tenantId, 'USER_SESSION', localUser01Session);
        });

        it('should not notify the session removal', () => {
            zervWithSyncModule.publish = null;
            service._destroyLocalUserSession(localUser01Session, 'destroy_test');
            expect(zervWithSyncModule.notifyDelete).not.toHaveBeenCalled();
        });
    });

    describe('logout function', () => {
        let localUserSession;

        beforeEach(async () => {
            spyOn(service, '_logoutLocally');
            localUserSession = {
                id: 'aSession',
                tenantId: 'corpPlus',
                origin: 'browserOriginId',
                zervServerId: 'thisServer'
            };
            spyOn(service, 'getLocalUserSession').and.returnValue(localUserSession);
        });

        it('should log out the session at the origin provided and notify to other servers', async () => {
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            await service.logout(localUserSession.origin, 'logout_test');
            expect(service._logoutLocally).toHaveBeenCalledWith(localUserSession, 'logout_test');

            expect(zervWithSyncModule.publish).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledTimes(1);
            expect(zervWithSyncModule.notifyCreation).toHaveBeenCalledWith(
                'corpPlus',
                'USER_SESSION_LOGGED_OUT',
                {id: 1580983567000, origin: 'browserOriginId', logoutReason: 'logout_test', zervServerId: 'thisServer'},
                {allServers: true}
            );
        });

        it('should log out the session at the origin provided and NOT notify when sync module is not used', async () => {
            service.init(zerv, io, maxInactiveTimeInMinsForInactiveSession);
            await service.logout(localUserSession.origin, 'logout_test');
            expect(service._logoutLocally).toHaveBeenCalledWith(localUserSession, 'logout_test');
            expect(zervWithSyncModule.publish).not.toHaveBeenCalled();
            expect(zervWithSyncModule.notifyCreation).not.toHaveBeenCalled();
        });

        it('should not release any session if the session does not exist for provided origin', async () => {
            service.init(zervWithSyncModule, io, maxInactiveTimeInMinsForInactiveSession);
            service.getLocalUserSession.and.returnValue(null);
            await service.logout('unknownSessionOnLocalServer', 'logout_test');
            expect(service._logoutLocally).not.toHaveBeenCalled();
            expect(zervWithSyncModule.notifyCreation).not.toHaveBeenCalled();
        });
    });

    describe('tenantMaximumActiveSessionTimeout value', () => {
        it('should be set and retrieve properly', () => {
            service.setTenantMaximumActiveSessionTimeout('prudentTenantId', 60);
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('prudentTenantId')).toEqual(60);
        });

        it('should be a default max value for invalid value', () => {
            service.setTenantMaximumActiveSessionTimeout('aTenant', -5);
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('aTenant')).toEqual(129600);
        });

        it('should user default max value when value is too high', () => {
            service.setTenantMaximumActiveSessionTimeout('aTenant', 500000);
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('aTenant')).toEqual(129600);
        });

        it('should be a default max value for inexisting tenant', () => {
            expect(service.getTenantMaximumActiveSessionTimeoutInMins('carelessTenantId')).toEqual(129600);
        });
    });

    describe('localSessionDestroy listener', () => {
        let localUserSession;

        beforeEach(async () => {
            localUserSession = {
                id: 'aSession',
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
    });
});


class MockSocket {
    constructor(obj) {
        _.assign(this, obj);
        this.connected = true;
        this.emit = jasmine.createSpy(this.id + '.emit');
    }

    connect() {
        this.connected = true;
        const s = _.find(io.sockets.sockets, {id: this.id});
        if (s) {
            throw new Error('something is wrong in the unit test, you are trying to connect the same socket twice.');
        }
        io.sockets.sockets.push(this);
        return service.connectUser(this);
    }

    disconnect() {
        this.connected = false;
        _.remove(io.sockets.sockets, {id: this.id});
        return service.disconnectUser(this);
    }
}
