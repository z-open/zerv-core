const _ = require('lodash');
const UUID = require('uuid');
const moment = require('moment');
const assert = require('assert');
const zlog = require('zimit-zlog');
const blackListService = require('./token-blacklist.service');
const redisService = require('./redis.service');

const logger = zlog.getLogger('zerv/core/userSession');

const zervServerId = UUID.v4();

let localUserSessions = {}, localUserSessionDestroyListeners = {}, tenantMaximumActiveSessionTimeouts = {};
let _clearOldUserSessionsIntervalHandle;
let zerv, socketServer;

const service = {
    init,

    setTenantMaximumActiveSessionTimeout,
    getTenantMaximumActiveSessionTimeoutInMins,

    connectUser,
    disconnectUser,
    onLocalUserSessionDestroy,
    isLocalUserSession,
    countLocalSessionsByUserId,
    isUserSessionServerOrigin,
    getLocalUserSessions,
    getServerInstanceId,
    logout,

    _clearOldUserSessions: _cleanInactiveLocalUserSessions,
    _clearOldUserSessionsInterval
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
 * @param {Number} maxInactiveTimeForInactiveSession
 */
function init(coreModule, io, maxInactiveTimeForInactiveSession) {
    assert(maxInactiveTimeForInactiveSession, 'maxInactiveTimeForInactiveSession must be defined to determine when inactive user session should be released from memory.');

    localUserSessions = {};
    localUserSessionDestroyListeners = {};
    tenantMaximumActiveSessionTimeouts = {};

    zerv = coreModule;
    socketServer = io;

    scheduleUserSessionMaintenance(maxInactiveTimeForInactiveSession);

    if (_.isFunction(zerv.publish)) {
        zerv.publish(
            'user-sessions.sync',
            // local sessions might be active or inactive (no socket connection to it)
            () => getLocalUserSessions(),
            'USER_SESSION'
        );

        zerv.onChanges('USER_SESSION_LOGGED_OUT', (tenantId, loggedOutSession) => {
            const userSession = localUserSessions[loggedOutSession.origin];
            if (userSession && !isUserSessionServerOrigin(loggedOutSession)) {
                logger.info('%s was requested to log out from another server', userSession);
                logoutLocally(userSession, loggedOutSession.logoutReason);
            }
        });
    }
}

function onLocalUserSessionDestroy(callback) {
    const listenerId = UUID.v4();
    localUserSessionDestroyListeners[listenerId] = callback;
    return () => delete localUserSessions[listenerId];
}

function notifyLocalUserSessionDestroy(localUserSession, reason) {
    const obj = _.clone(localUserSession);
    _.forEach(localUserSessionDestroyListeners, (listener) => listener(obj, reason));
}

async function connectUser(socket) {
    await updateLocalUserSession(socket);
}

async function disconnectUser(socket, why) {
    if (_.isNil(localUserSessions[socket.origin])) {
        // there is no session on this socket. The socket has never received a token.
        return;
    }
    await updateLocalUserSession(socket);
}

function scheduleUserSessionMaintenance(maxInactiveTimeForInactiveSession) {
    maxInactiveTimeForInactiveSession = 0.5;
    _clearOldUserSessionsIntervalHandle = setInterval(
        () => {
            service._clearOldUserSessions(maxInactiveTimeForInactiveSession);
        },
        maxInactiveTimeForInactiveSession * 60000
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
function _cleanInactiveLocalUserSessions(maxInactiveTimeForInactiveSession) {
    _.forEach(_.values(localUserSessions), (userSession) => {
        if (!userSession.active && moment.duration(moment(new Date()).diff(userSession.lastUpdate)).asMinutes()>maxInactiveTimeForInactiveSession) {
            // removing a local user will notify potential local session listener to remove their resources since the user is no longer connected to the server
            removeLocalUserSession(userSession, 'garbage_collected');
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


/*
user goes to credentials
ui create the origin based on refreshed token

if it goes to credentials page again, the origin will not change
if it comes from SSO (dash), the origin will not change

the session is created and should removed on logout


Constraint
User might open multiple browser on the app, each tab might be connected to different servers
all tab will send a request to refresh... make sure only one does otherwise too many token refreshs.

Credentialized
if a user has just credentialized which means it provides the authcode token (coming from SSO or initiated a login in default zimit login)

If there has no origin (browser), it is surely a brand new session
    create the session and post in redis
Otherwise
    find if the session exists with the origin in redis
    if YES,
       check if the session belongs for the uer that has just credentialized
       - if no, re-create a new session an post in redis
       - if yes, update the session activity (is it useful??)
    Otherwise,
       create the session and post in redis

On auto logout or manual logout
    server needs to remove the session as it is no useful anymore
*/

async function updateLocalUserSession(socket) {
    let userSession = localUserSessions[socket.origin];
    // new session? or user has changed at the origin (browser) make sure lib drpped the origin
    if (!userSession || userSession.userId !== socket.userId) {
        userSession = await createLocalUserSession(socket);
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

        // cluster info:
        this.clusterCreation = null;
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
        return `session ${this.origin.substr(-8)} for user ${this.userId.substr(-8)} (${this.firstName} ${this.lastName})`;
    }
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
 */
async function createLocalUserSession(socket) {
    const userSession = new LocalUserSession(socket);
    if (redisService.isRedisEnabled()) {
        const clusterUserSession = await getClusterUserSession(userSession);
        _.assign(userSession, clusterUserSession);
    } else {
        // since there is no cluster to provide the info.
        userSession.maxActiveDuration = await getTenantMaximumActiveSessionTimeoutInMins(userSession.tenantId);
    }
    logger.info('Create new local %s', userSession);
    localUserSessions[socket.origin] = userSession;
    if (zerv.publish) {
        zerv.notifyCreation(userSession.tenantId, 'USER_SESSION', userSession);
    }
    userSession.timeout = scheduleAutoLogout(userSession);
    return userSession;
}

function removeLocalUserSession(userSession, reason) {
    userSession.active = false;
    clearTimeout(userSession.timeout);
    delete localUserSessions[userSession.origin];

    notifyLocalUserSessionDestroy(userSession, reason);

    if (zerv.publish) {
        zerv.notifyDelete(userSession.tenantId, 'USER_SESSION', userSession);
    }
    logger.info('Removed %s from this server - ', userSession, reason);
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
 * @param {SocketIO} localUserSession
 */
async function getClusterUserSession(localUserSession) {
    // usually origin is the browser connected to this socket
    const origin = localUserSession.origin;
    let clusterUserSession = await findClusterUserSession(origin);
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
        origin,
        tenantId: localUserSession.tenantId,
        // if we were to bounce all redis and servers, creation date time of the session will be when the socket reconnects.
        // Redis is key to maintain session creation date
        clusterCreation: new Date(),
        firstName: localUserSession.firstName,
        lastName: localUserSession.lastName,
        maxActiveDuration: await getTenantMaximumActiveSessionTimeoutInMins(localUserSession.tenantId)
    };
    logger.info('Add to cluster %s', localUserSession);
    await saveClusterUserSession(clusterUserSession);
    return clusterUserSession;
}

function scheduleAutoLogout(userSession) {
    const remainingTime = userSession. getRemainingTimeInSecs();
    const maximumSessionTime = userSession.getMaximumSessionTime();

    if (remainingTime <= 0) {
        // the session has no remaining time
        logger.info('%s expired on %s.', userSession, maximumSessionTime);
        logout(userSession.origin, 'session_timeout');
        return null;
    }
    logger.info('%s is set to expire in %s min(s) on %s', userSession, (remainingTime/60).toFixed(1), moment(maximumSessionTime));
    return setTimeout(
        () => logout(userSession.origin, 'session_timeout'),
        remainingTime * 1000
    );
}

async function logout(origin, reason) {
    const userSession = localUserSessions[origin];
    await logoutLocally(userSession, reason);
    if (zerv.publish) {
        zerv.notifyCreation(
            userSession.tenantId, 'USER_SESSION_LOGGED_OUT',
            {
                id: Date.now(), // notif requires id
                origin,
                logoutReason: reason
            },
            {allServers: true}
        );
    }
}

async function logoutLocally(userSession, reason) {
    logger.info('Logging out %s - %s', userSession, reason);
    userSession.active = false;

    removeLocalUserSession(userSession, reason);

    _.forEach(socketServer.sockets.sockets, async (socket) => {
        if (socket.origin === userSession.origin) {
            await blackListService.blackListToken(socket.token);
            socket.emit('logged_out', reason);
        }
    });
    // another server might already have deleted the cluster user session from the cluster as all servers that particate in this session would  timeout at the same time.
    if (redisService.isRedisEnabled()) {
        deleteClusterUserSession(userSession.origin);
    }
    return userSession;
}

function countLocalUserSessionConnections(origin) {
    // socket valid? or disconnected?
    return _.filter(socketServer.sockets.sockets, {origin, connected: true}).length;
}

function setTenantMaximumActiveSessionTimeout(tenantId, valueInMins) {
    tenantMaximumActiveSessionTimeouts[tenantId] = valueInMins;
}

function getTenantMaximumActiveSessionTimeoutInMins(tenantId) {
    // in minutes
    const value = tenantMaximumActiveSessionTimeouts[tenantId];
    return _.isNil(value) || value < 1 ? process.env.ZERV_MAX_ACTIVE_SESSION_TIMEOUT_IN_MINS || 60 * 12: value;
}

async function findClusterUserSession(origin) {
    const result = await redisService.getRedisClient().get('SESSION_' + origin);
    return _.isNil(result) ? null : JSON.parse(result);
}

async function saveClusterUserSession(clusterUserSession) {
    // should be
    await redisService.getRedisClient().setex('SESSION_' + clusterUserSession.origin, clusterUserSession.maxActiveDuration * 60, JSON.stringify(clusterUserSession));
}

async function deleteClusterUserSession(origin) {
    await redisService.getRedisClient().del('SESSION_' + origin);
}
