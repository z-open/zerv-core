const _ = require('lodash');
const UUID = require('uuid');
const moment = require('moment');
const assert = require('assert');
const zlog = require('zimit-zlog');
const blackListService = require('./token-blacklist.service');
const redisService = require('./redis.service');
const logger = zlog.getLogger('zerv/userSession');

const zervServerId = UUID.v4();

let localUserSessions = {};
let _clearOldUserSessionsIntervalHandle;
let zerv, socketServer;

const CLUSTER_USER_SESSIONS = 'CL_USER_SESSIONS';
const CLUSTER_USER_SESSION_CHECK = 'CL_USER_SESSION_CHECK';

const service = {
    init,
    onUserConnect,
    onUserDisconnect,
    isLocalUserSession,
    countLocalSessionsByUserId,
    isUserSessionServerOrigin,
    getLocalUserSessions,
    getServerInstanceId,
    logout,

    _clearOldUserSessions: _cleanInactiveLocalUserSessions,
    _clearOldUserSessionsInterval,
    _cleanClusterUserSessionOrphans
};

module.exports = service;

function getServerInstanceId() {
    return zervServerId;
}

function init(coreModule, io, maxInactiveTimeForInactiveSession) {
    assert(maxInactiveTimeForInactiveSession, 'maxInactiveTimeForInactiveSession must be defined to determine when inactive user session should be released from memory.');
    localUserSessions = {};
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
    }
}

async function onUserConnect(socket) {
    await updateLocalUserSession(socket);
}

async function onUserDisconnect(socket, why) {
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
            if (redisService.isRedisEnabled()) {
                service._cleanClusterUserSessionOrphans();
            }
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

/**
 * When a user logs out or on auto logout (on maxActiveDuration), the cluster session is removed
 * However, if the server crashes before or during the process of logging out,
 * the cluster session will never be deleted.
 * This process checks and delete all expired sessions from the cluster.
 */
async function _cleanClusterUserSessionOrphans() {
    const lastClusterMaintenanceExecution = await getLastClusterMaintenanceExecution();
    if (lastClusterMaintenanceExecution && moment.duration(moment().diff(lastClusterMaintenanceExecution)).asHours() < 6) {
        // some other server has recently run this. let's not do it again yet. it is not critical
        return;
    }
    await updateLastClusterMaintenanceExecution();
    const allSessions = await findClusterUserSessions();
    for (const clusterSession of allSessions) {
        if (hasUserSessionExpired(clusterSession)) {
            await deleteClusterUserSession(clusterSession.origin);
        }
    }
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
        if (zerv.publish) {
            zerv.notifyCreation(userSession.tenantId, 'USER_SESSION', userSession);
        }
    } else {
        userSession.revision++;
    }
    userSession.lastUpdate = new Date();
    const newCount = countLocalUserSessionConnections(socket.origin);
    // a socket might have disconnected from this server, but there might be other sockets still connected from the same origin (multible tabs in browser)
    userSession.active = newCount > 0;
    if (userSession.connections !== newCount) {
        logger.info('User session for user %s %s %s is %s and has now %s connection(s) on this server', userSession.userId, userSession.firstName, userSession.lastName, userSession.active ? 'ACTIVE' : 'INACTIVE', newCount);
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
 */
async function createLocalUserSession(socket) {
    const userSession = {
        id: UUID.v4(),
        zervServerId: service.getServerInstanceId(),
        creation: new Date(), // local creation might be different from the cluster creation
        revision: 0,
        userId: socket.userId,
        origin: socket.origin,
        tenantId: socket.tenantId,
        payload: socket.payload,
        // payload should have the name provided
        firstName: socket.payload.firstName,
        lastName: socket.payload.lastName,

    };
    if (redisService.isRedisEnabled()) {
        const clusterUserSession = await getClusterUserSession(userSession);
        _.assign(userSession, clusterUserSession);
    } else {
        // since there is no cluster to provide the info.
        userSession.maxActiveDuration = await getTenantMaximumActiveSessionTimeoutInMins(userSession.tenantId);
    }
    logger.info('New user session (local) for user %s %s %s', userSession.userId, userSession.firstName, userSession.lastName);
    localUserSessions[socket.origin] = userSession;
    userSession.timeout = scheduleAutoLogout(userSession);
    return userSession;
}

function removeLocalUserSession(userSession, reason) {
    userSession.active = false;
    clearTimeout(userSession.timeout);
    delete localUserSessions[userSession.origin];
    if (zerv.publish) {
        zerv.notifyDelete(userSession.tenantId, 'USER_SESSION', userSession);
    }
    logger.info('Removed user session for user %s %s %s from this server - ', userSession.userId, userSession.firstName, userSession.lastName, reason);
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
    if (!clusterUserSession) {
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
        logger.info('New user session (cluster) for user %s %s %s', clusterUserSession.userId, clusterUserSession.firstName, clusterUserSession.lastName);

        await saveClusterUserSession(clusterUserSession);
    }
    return clusterUserSession;
}

function scheduleAutoLogout(userSession) {
    const {remainingTime, maximumSessionTime} = calculateRemainingSessionTimeInSeconds(userSession);
    if (remainingTime <= 0) {
        // the session has no remaining time
        logger.info('User session for user %s %s %s expired on %s.', userSession.userId, userSession.firstName, userSession.lastName, maximumSessionTime);
        logout(userSession.origin, 'session_timeout');
        return null;
    }
    logger.info('User session for user %s %s %s is set to expire in %s min(s) on %s ', userSession.userId, userSession.firstName, userSession.lastName, (remainingTime/60).toFixed(1), moment(maximumSessionTime));
    return setTimeout(
        () => logout(userSession.origin, 'session_timeout'),
        remainingTime * 1000
    );
}

function calculateRemainingSessionTimeInSeconds(userSession) {
    const maximumSessionTime = getMaximumSessionTime(userSession);
    const duration = moment.duration(moment(maximumSessionTime).diff()).asSeconds();
    return {
        remainingTime: duration>0 ? duration : 0,
        maximumSessionTime
    };
}

async function logout(origin, reason) {
    const userSession = localUserSessions[origin];
    logger.info('Logging out userId %b %s %s - %s', userSession.userId, userSession.firstName, userSession.lastName, reason);
    userSession.active = false;
    _.forEach(socketServer.sockets.sockets, async (socket) => {
        if (socket.origin === origin) {
            await blackListService.blackListToken(socket.token);
            socket.emit('logged_out', reason);
        }
    });
    removeLocalUserSession(userSession, reason);
    // another server might already have deleted the cluster user session from the cluster as all servers that particate in this session would  timeout at the same time.
    if (redisService.isRedisEnabled()) {
        deleteClusterUserSession(userSession.origin);
    }
}

function countLocalUserSessionConnections(origin) {
    // socket valid? or disconnected?
    return _.filter(socketServer.sockets.sockets, {origin, connected: true}).length;
}

function getTenantMaximumActiveSessionTimeoutInMins(tenantId) {
    // in minutes
    return 1;
}

function hasUserSessionExpired(clusterUserSession) {
    if (!clusterUserSession.clusterCreation) {
        return true;
    }
    const expiresOn = getMaximumSessionTime(clusterUserSession);
    return moment().isAfter(expiresOn);
}

function getMaximumSessionTime(userSession) {
    // based on the cluster session
    // if no cluster (redis), then creation date of the local session
    return moment(userSession.clusterCreation || userSession.creation).add(userSession.maxActiveDuration, 'minutes').toDate();
}

async function findClusterUserSession(origin) {
    const result = await redisService.getRedisClient().hget(CLUSTER_USER_SESSIONS, origin);
    return _.isNil(result) ? null : JSON.parse(result);
}

async function saveClusterUserSession(clusterUserSession) {
    await redisService.getRedisClient().hset(CLUSTER_USER_SESSIONS, clusterUserSession.origin, JSON.stringify(clusterUserSession));
}

async function deleteClusterUserSession(origin) {
    await redisService.getRedisClient().hdel(CLUSTER_USER_SESSIONS, origin);
}

async function findClusterUserSessions() {
    const allClusterSessions = await redisService.getRedisClient().hvals(CLUSTER_USER_SESSIONS);
    return _ .map(allClusterSessions, JSON.parse);
}

async function getLastClusterMaintenanceExecution() {
    const date = await redisService.getRedisClient().get(CLUSTER_USER_SESSION_CHECK);
    return date ? new Date(date) : null;
}

async function updateLastClusterMaintenanceExecution() {
    await redisService.getRedisClient().set(CLUSTER_USER_SESSION_CHECK, JSON.stringify(new Date()));
}
