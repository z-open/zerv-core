const _ = require('lodash');
const UUID = require('uuid');
const moment = require('moment');
const assert = require('assert');
const zlog = require('zimit-zlog');
const tokenBlacklistService = require('./token-blacklist.service');
const cacheService = require('./cache.service');
const utils = require('./utils');

const logger = zlog.getLogger('zerv/core/userSession');

const zervServerId = UUID.v4();
const REDIS_SESSION_PREFIX = 'SESSION_';
const DEFAULT_MAX_ACTIVE_SESSION_TIMEOUT_IN_MINS = 90 * 24 *60;
const DEFAULT_MAX_INACTIVE_SESSION_TIMEOUT_IN_MINS = 12 *60;

let localUserSessions = {};
let localUserSessionDestroyListeners = {};
let tenantMaximumActiveSessionTimeouts = {};
let tenantMaximumInactiveSessionTimeouts = {};
let _clearOldUserSessionsIntervalHandle;
let zerv, socketServer;

class LocalUserSession {
    constructor(socket) {
        this.id = UUID.v4();
        this.zervServerId = service.getServerInstanceId();
        this.creation = new Date(); // local creation might be different from the cluster creation
        this.revision = 0;
        this.userId = socket.userId;
        this.origin = socket.origin;
        this.tenantId = socket.tenantId;
        this.payload = socket.payload;
        // payload should have the name provided
        this.firstName = socket.payload.firstName;
        this.lastName = socket.payload.lastName;
        this.maxActiveDuration = null; // in minutes
        this.timeout = null;

        // cluster info:
        this.clusterCreation = null;
        this.clusterUserSessionId = null;
    }

    getMaximumSessionTime() {
        return moment(this.clusterCreation || this.creation).add(this.maxActiveDuration, 'minutes').toDate();
    }

    getRemainingTimeInSecs() {
        const maximumSessionTime = this.getMaximumSessionTime(this);
        const duration = moment.duration(moment(maximumSessionTime).diff()).asSeconds();
        return duration>0 ? duration : 0;
    }

    toJSON() {
        return _.omit(this, ['timeout']);
    }

    toString() {
        const user = !_.isString(this.userId) ? `${this.firstName} ${this.lastName})` : `${this.userId.substr(-8)} (${this.firstName} ${this.lastName})`;
        return `session ${this.origin.substr(-8)} for user ${user})`;
    }
}

const service = {
    init,

    setTenantMaximumActiveSessionTimeout,
    getTenantMaximumActiveSessionTimeoutInMins,

    setTenantMaximumInactiveSessionTimeout,
    getTenantMaximumInactiveSessionTimeoutInMins,

    connectUser,
    disconnectUser,
    isUserSessionActive,
    notifyUserSessionActivity,

    onLocalUserSessionDestroy,
    isLocalUserSession,
    countLocalSessionsByUserId,
    isUserSessionServerOrigin,
    getLocalUserSessions,
    getLocalUserSession,
    getServerInstanceId,
    logout,

    _scheduleAutoLogout,
    _getClusterUserSession,
    _removeAllInactiveLocalUserSessions,
    _destroyLocalUserSession,
    _clearOldUserSessionsInterval,
    _logoutLocally,
    _scheduleUserSessionMaintenance,
    _handleLogoutNotification,
    _notifyLocalUserSessionDestroy,
    _findClusterUserSession,
    _updateLocalUserSession,
    _clearLocalUserSessions
};

module.exports = service;

function getServerInstanceId() {
    return zervServerId;
}
/**
 * Initialize the session management module
 * - schedule session maintenance
 * - Publish session information
 *
 * Notes about implementing/testing user session in a cluster:
 * ----------------------------------------------------------
 * - start multiple zerv servers on different ports
 * - install nginx
 * - set up config (https://www.nginx.com/blog/nginx-nodejs-websockets-socketio/) to
 *
#user  nobody;
worker_processes  1;

#error_log  logs/error.log;
#error_log  logs/error.log  notice;
#error_log  logs/error.log  info;
#pid        logs/nginx.pid;
events {
    worker_connections  1024;
}
http {
    upstream farm {
        #        ip_hash;
        least_conn;
        server localhost:5000;
        server localhost:5010;
    }

    server {
        listen 8080;
        server_name localhost;
        location / {
            # headers necessary to proxy web socket
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_http_version 1.1;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            # headers useful to detect origin of the request
            proxy_set_header   Host      $http_host;
            proxy_set_header x-forwarded-port $server_port;
            proxy_pass http://farm;
        }
    }
}
 * Load balancing
 * --------------
 * https://mashhurs.wordpress.com/2016/09/30/polling-vs-websocket-transport/
 * https://blog.jscrambler.com/scaling-node-js-socket-server-with-nginx-and-redis/
 * https://www.nginx.com/blog/nginx-nodejs-websockets-socketio/
 * http://nginx.org/en/docs/http/load_balancing.html#nginx_load_balancing_with_ip_hash
 *
 * If a user opens multiple tabs with the client app:
 *
 * ip_hash:
 * if the nginx uses ip_hash all connections of the browser will be on the same node server.
 * io client uses polling by default before establishing the websocket then the sticky session is necessary
 *
 * least_conn:
 * using least_conn, distributes the connections over all servers using the least use.
 * however, io client must be then forced to use  transports: ['websocket']
 * The issue is if the websocket cannot be established or maintained the app will not work (dig in this)

 *
 * @param {Object} coreModule
 * @param {SocketIOServer} io
 * @param {Number} inactiveLocalUserSessionTimeoutInMins
 */
function init(coreModule, io, inactiveLocalUserSessionTimeoutInMins) {
    assert(inactiveLocalUserSessionTimeoutInMins, 'inactiveLocalUserSessionTimeoutInMins must be defined to determine when inactive user session should be released from memory.');

    localUserSessions = {};
    localUserSessionDestroyListeners = {};
    tenantMaximumActiveSessionTimeouts = {};
    tenantMaximumInactiveSessionTimeouts = {};

    zerv = coreModule;
    socketServer = io;

    service._scheduleUserSessionMaintenance(inactiveLocalUserSessionTimeoutInMins);

    if (_.isFunction(zerv.publish)) {
        zerv.publish(
            'user-sessions.sync',
            // local sessions might be active or inactive (no socket connection to it)
            () => getLocalUserSessions(),
            'USER_SESSION'
        );

        zerv.onChanges('USER_SESSION_LOGGED_OUT', service._handleLogoutNotification);
    }
}

function _clearLocalUserSessions() {
    localUserSessions = {};
}

function _handleLogoutNotification(tenantId, loggedOutSession) {
    const userSession = service.getLocalUserSession(loggedOutSession.origin);
    if (userSession && !isUserSessionServerOrigin(loggedOutSession)) {
        logger.info('%s was requested to log out from another server', userSession);
        service._logoutLocally(userSession, loggedOutSession.logoutReason);
    }
}

function onLocalUserSessionDestroy(callback) {
    const listenerId = UUID.v4();
    localUserSessionDestroyListeners[listenerId] = callback;
    return () => delete localUserSessionDestroyListeners[listenerId];
}

function _notifyLocalUserSessionDestroy(localUserSession, reason) {
    _.forEach(localUserSessionDestroyListeners, (listener) => listener(localUserSession, reason));
}

async function connectUser(socket) {
    return await service._updateLocalUserSession(socket);
}

async function disconnectUser(socket, why) {
    if (_.isNil(service.getLocalUserSession(socket.origin))) {
        // there is no session on this socket. The socket has never received a token.
        return;
    }
    await service._updateLocalUserSession(socket);
}

function _scheduleUserSessionMaintenance(inactiveLocalUserSessionTimeoutInMins) {
    // inactiveLocalUserSessionTimeoutInMins = 0.5;
    _clearOldUserSessionsIntervalHandle = setInterval(
        () => {
            service._removeAllInactiveLocalUserSessions(inactiveLocalUserSessionTimeoutInMins);
        },
        inactiveLocalUserSessionTimeoutInMins * 60000
    );
}
/**
 * A session might be reactivated if the jwt token is not expired
 * if a session is inactive and its token has expired for sometime
 * It means this session is gone, and user will need to log in again
 *
 * Let's remember, a session might become inactive because the socket got disconnected
 * it happens often on the web (ex browser put in the background can cause this),
 * but browser will reconnect at some point. it does not mean the user needs to relogin
 */
function _removeAllInactiveLocalUserSessions(inactiveLocalUserSessionTimeoutInMins) {
    _.forEach(service.getLocalUserSessions(), (userSession) => {
        if (!userSession.active && moment.duration(moment(new Date()).diff(userSession.lastUpdate)).asMinutes()>inactiveLocalUserSessionTimeoutInMins) {
            // removing a local user will notify potential local session listener to remove their resources since the user is no longer connected to the server
            service._destroyLocalUserSession(userSession, 'garbage_collected');
        }
    });
}

function _clearOldUserSessionsInterval() {
    localUserSessions = {};
    clearInterval(_clearOldUserSessionsIntervalHandle);
}

/**
 * check if a user is handled by this instance of zerv.
 *
 * @param {Object} userSession
 * @returns {Boolean} true if the user session belongs to this instance of zerv.
 */
function isLocalUserSession(userSession) {
    return !_.some(localUserSessions, (existingSession) => existingSession.id === userSession.id);
}

/**
 * Provide the count of active sessions for provided user on this server, max would be 1!!!
 *
 * @param {String} userId
 * @returns {Number} session count
 */
function countLocalSessionsByUserId(userId) {
    return _.filter(localUserSessions, (existingSession) => existingSession.active && existingSession.userId === userId).length;
}

function isUserSessionServerOrigin(userSession) {
    return userSession.zervServerId === service.getServerInstanceId();
}

function getLocalUserSessions() {
    return _.values(localUserSessions);
}

function getLocalUserSession(origin) {
    return localUserSessions[origin];
}


// DO NOT REMOVE NOTES YET:
// user goes to credentials
// ui create the origin based on refreshed token
// if it goes to credentials page again, the origin will not change
// if it comes from SSO (dash), the origin will not change
// the session is created and should removed on logout

// Constraint
// User might open multiple browser tabs on the app, each tab might be connected to different servers
// all tabs will send a request to refresh... make sure only one does otherwise too many token refreshs.

// Credentialized
// if a user has just credentialized which means it provides the authcode token (coming from SSO or initiated a login in default zimit login)

// If there has no origin (browser), it is surely a brand new session
//     create the session and post in redis
// Otherwise
//     find if the session exists with the origin in redis
//     if YES,
//        check if the session belongs for the uer that has just credentialized
//        - if no, re-create a new session an post in redis
//        - if yes, update the session activity (is it useful??)
//     Otherwise,
//        create the session and post in redis

// On auto logout or manual logout
//     server needs to remove the session as it is no useful anymore


async function _updateLocalUserSession(socket) {
    let userSession = service.getLocalUserSession(socket.origin);
    // new session? or user has changed at the origin (browser) make sure lib drpped the origin
    if (!userSession || userSession.userId !== socket.userId) {
        userSession = await createLocalUserSession(socket);
        socket.localUserSession = userSession;
    } else {
        userSession.revision++;
    }
    userSession.lastUpdate = new Date();
    const newCount = countLocalUserSessionConnections(socket.origin);
    // a socket might have disconnected from this server, but there might be other sockets still connected from the same origin (multible tabs in browser)
    userSession.active = newCount > 0;
    if (userSession.connections !== newCount) {
        logger.info('%s is %s and has now %s connection(s) on this server - remaining session time: %s mins', userSession, userSession.active ? 'ACTIVE' : 'INACTIVE', newCount, (userSession.getRemainingTimeInSecs()/60).toFixed(1));
        userSession.connections = newCount;
    }
    return userSession;
}

/**
 * In order to know if a user is connected on this local server a local session is created.
 * A user can have multiple connections (tab) to this server from the same origin (browser)
 * A local session remains active until all tabs are closed in that origin.
 * If all connections are closed on that origin, the local session will get removed after a while
 * (system needs to make sure it is not just a temporary network disconnections)
 * However the cluster user session will not be removed until logging out (manually or server auto logout)
 *
 * @param {SocketIO} socket
 * @returns {Promise<LocalUserSession>}
 */
async function createLocalUserSession(socket) {
    const userSession = new LocalUserSession(socket);
    const clusterUserSession = await service._getClusterUserSession(userSession);
    _.assign(userSession, clusterUserSession);

    logger.info('Create new local %s', userSession);
    localUserSessions[socket.origin] = userSession;
    if (zerv.publish) {
        zerv.notifyCreation(userSession.tenantId, 'USER_SESSION', userSession);
    }
    userSession.timeout = service._scheduleAutoLogout(userSession);
    return userSession;
}

async function isUserSessionActive(origin) {
    const existingSession = await service._findClusterUserSession(origin);

    if (!existingSession) {
        // this session no longer exist if ever existed.
        return false;
    }
    // check if the session is inactive for long or even expired
    const timeSinceLastActivity = Date.now() - new Date(existingSession.lastUserActivity).getTime();
    const result = timeSinceLastActivity < (service.getTenantMaximumInactiveSessionTimeoutInMins(existingSession.tenantId) * 60 * 1000);
    return result;
}

async function notifyUserSessionActivity(origin, logMsg) {
    const localUserSession = service.getLocalUserSession(origin);
    if (localUserSession) {
        localUserSession.lastUserActivity = new Date();
        localUserSession.lastUserActivityStatus = logMsg;
        logger.debug('User activity notified: %s - %s', localUserSession, logMsg || 'No details');
    }
    // this could be optimized to only send a key with the last activity instead of updating the whole object
    const clusterUserSession = await service._findClusterUserSession(origin);
    if (clusterUserSession) {
        clusterUserSession.lastUserActivity = new Date();
        clusterUserSession.lastUserActivityStatus = logMsg;
        await upsertClusterUserSession(clusterUserSession);
    }
}

function _destroyLocalUserSession(userSession, reason) {
    userSession.active = false;
    utils.clearLongTimeout(userSession.timeout);
    userSession.timeout = null;
    delete localUserSessions[userSession.origin];

    service._notifyLocalUserSessionDestroy(userSession, reason);

    if (zerv.publish) {
        zerv.notifyDelete(userSession.tenantId, 'USER_SESSION', userSession);
    }
    logger.info('Removed %s from this server - %s', userSession, reason);
}

/**
 * A cluster user session contains the following information
 * - the origin of the session (browser)
 * - the date of the session creation.
 * - the session maximum duration
 *
 * A cluster session is created when the user logs in a server.
 *
 * The session is removed by:
 * - user logs out
 * - automatic logout on session expiration
 *   All servers involved in the session (have a local session and socket connections) plan to
 *   trigger the automatic logout using the session creation date.
 *   Even if one of those servers is no responsive or crashes, the automatic logout will still happen
 * - the clean up tasks for session orphans (sessions that were not logged out due to server irresponsive)
 *
 * Later on, the cluster session could be enhanced:
 * - It could maintain the number of all connections
 * and the sate of connections (active inactive). but there is no need to that at this time.
 * - the cluster session could also hold or be associated to session variables made available to the whole cluster.
 *
 * @param {LocalUserSession} localUserSession
 * @returns {Promise<Object>} cluster session object
 *
 */
async function _getClusterUserSession(localUserSession) {
    // usually origin is the browser connected to this socket
    const origin = localUserSession.origin;
    let clusterUserSession = await service._findClusterUserSession(origin);
    if (clusterUserSession && clusterUserSession.userId !== localUserSession.userId) {
        clusterUserSession = null;
    }
    if (clusterUserSession) {
        logger.info('Found existing cluster %s started on ', localUserSession, moment(clusterUserSession.clusterCreation).format());
        return clusterUserSession;
    }
    clusterUserSession = {
        clusterUserSessionId: UUID.v4(),
        userId: localUserSession.userId,
        // origin of the connection
        origin,
        tenantId: localUserSession.tenantId,
        // if we were to bounce all redis and servers, creation date time of the session will be when the socket reconnects.
        // Redis is key to maintain session creation date
        clusterCreation: new Date(),
        // the cluster session has just been created because user logged in. this is a voluntary activity
        lastUserActivity: new Date(),
        lastUserActivityStatus: 'NEW SESSION',
        firstName: localUserSession.firstName,
        lastName: localUserSession.lastName,
        maxActiveDuration: await getTenantMaximumActiveSessionTimeoutInMins(localUserSession.tenantId)
    };
    logger.info('Add to cluster %s', localUserSession);
    await upsertClusterUserSession(clusterUserSession);
    return clusterUserSession;
}

function _scheduleAutoLogout(userSession) {
    const remainingTime = userSession. getRemainingTimeInSecs() / 60;
    const maximumSessionTime = userSession.getMaximumSessionTime();

    if (remainingTime <= 0) {
        // the session has no remaining time, let's kickout the user
        logger.info('%s expired on %s.', userSession, maximumSessionTime);
        service.logout(userSession.origin, 'session_timeout');
        return null;
    }
    logger.info('%s is set to expire in %s min(s) on %s', userSession, remainingTime.toFixed(1), moment(maximumSessionTime));
    return utils.setLongTimeout(
        () => service.logout(userSession.origin, 'session_timeout'),
        remainingTime
    );
}

async function logout(origin, reason) {
    const userSession = service.getLocalUserSession(origin);
    if (!userSession) {
        // this handles the very rare edge case where the logout is received on the socket while
        // the client is in the process of getting authorized (maybe after a loss of connection) on a server that
        // was never connected (local session is about to be created asynchronously).
        // The open door for hacking is very very tight - Potentially other servers will not get logged out
        // until zerv purges the inactive sessions by itself.
        // So this could be optimized, for ie:
        // Make more secure in the future by looking in the shared cache in a cluster session exists at the origin and notify all servers
        // to make sure all servers log out (resource release) and related active tokens are revoked properly right away.
        return null;
    }
    await service._logoutLocally(userSession, reason);
    if (zerv.publish) {
        zerv.notifyCreation(
            userSession.tenantId, 'USER_SESSION_LOGGED_OUT',
            {
                id: Date.now(), // zerv notif requires id but not revision
                origin,
                logoutReason: reason,
                zervServerId: userSession.zervServerId
            },
            // let's not optimized for now this rare event and broadcast all servers.
            {allServers: true}
        );
    }
    return userSession;
}

async function _logoutLocally(userSession, reason) {
    logger.info('Logging out %s - %s', userSession, reason);
    userSession.active = false;

    service._destroyLocalUserSession(userSession, reason);

    // log out all session related sockets simultaneously.
    socketServer.sockets.sockets.forEach((socket) => {
        if (socket.origin === userSession.origin) {
            _logoutSocket(socket, reason);
        }
    });
    // FYI: another server might already have deleted the cluster user session from the cluster
    // All servers that particate in this session would  timeout at about the same time.
    // if (cacheService.isClusterCacheEnabled()) {
    deleteClusterUserSession(userSession.origin);
    // }
    return userSession;
}

async function _logoutSocket(socket, reason) {
    await tokenBlacklistService.revokeToken(socket.token, socket.payload.exp);
    socket.emit('logged_out', reason);
}

function countLocalUserSessionConnections(origin) {
    // socket valid? or disconnected?
    let count = 0;
    socketServer.sockets.sockets.forEach((socket) => {
        if (socket.origin === origin && socket.connected === true) {
            count++;
        }
    });
    return count;
}

function setTenantMaximumActiveSessionTimeout(tenantId, valueInMins) {
    tenantMaximumActiveSessionTimeouts[tenantId] = valueInMins;
}

function getTenantMaximumActiveSessionTimeoutInMins(tenantId) {
    const valueInMins = tenantMaximumActiveSessionTimeouts[tenantId];
    if (_.isNil(valueInMins) || valueInMins < 1 || valueInMins > DEFAULT_MAX_ACTIVE_SESSION_TIMEOUT_IN_MINS) {
        return DEFAULT_MAX_ACTIVE_SESSION_TIMEOUT_IN_MINS;
    }
    return valueInMins;
}

function setTenantMaximumInactiveSessionTimeout(tenantId, valueInMins) {
    tenantMaximumInactiveSessionTimeouts[tenantId] = valueInMins;
}

function getTenantMaximumInactiveSessionTimeoutInMins(tenantId) {
    const valueInMins = tenantMaximumInactiveSessionTimeouts[tenantId];
    if (_.isNil(valueInMins) || valueInMins < 1 || valueInMins > DEFAULT_MAX_INACTIVE_SESSION_TIMEOUT_IN_MINS) {
        return DEFAULT_MAX_INACTIVE_SESSION_TIMEOUT_IN_MINS;
    }
    return valueInMins;
}

async function _findClusterUserSession(origin) {
    return cacheService.getCachedObject(origin, {prefix: REDIS_SESSION_PREFIX});
}

async function upsertClusterUserSession(clusterUserSession) {
    await cacheService.cacheData(
        clusterUserSession.origin,
        clusterUserSession,
        {
            prefix: REDIS_SESSION_PREFIX,
            // if it is an update, theire is not need to modify the expiration time
            expirationInMins: clusterUserSession.lastUserActivityStatus === 'NEW SESSION' ? clusterUserSession.maxActiveDuration : null
        }
    );
}

async function deleteClusterUserSession(origin) {
    await cacheService.removeCachedData(origin, {prefix: REDIS_SESSION_PREFIX});
}
