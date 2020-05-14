const _ = require('lodash');
const UUID = require('uuid');
const moment = require('moment');
const assert = require('assert');
const zlog = require('zimit-zlog');
const logger = zlog.getLogger('zerv/userSession');

const zervServerId = UUID.v4();

let localUserSessions = {};
let _clearOldUserSessionsIntervalHandle;

const service = {
    createUserSessionEventHandler,
    isLocalUserSession,
    countLocalSessionsByUserId,
    isUserSessionServerOrigin,
    getLocalUserSessions,
    getServerInstanceId,

    _clearOldUserSessions,
    _clearOldUserSessionsInterval
};

module.exports = service;

function getServerInstanceId() {
    return zervServerId;
}

function createUserSessionEventHandler(coreModule, io, maxInactiveTimeForInactiveSession, onUserConnect, onUserDisconnect) {
    assert(maxInactiveTimeForInactiveSession, 'maxInactiveTimeForInactiveSession must be defined to determine when user session should be released from memory.');
    localUserSessions = {};

    _clearOldUserSessionsIntervalHandle = setInterval(
        () => service._clearOldUserSessions(maxInactiveTimeForInactiveSession),
        maxInactiveTimeForInactiveSession * 60000
    );

    if (_.isFunction(coreModule.publish)) {
        coreModule.publish(
            'user-sessions.sync',
            () => _.map(io.sockets.sockets, (socket) => {
                const userSession = formatSession(socket);
          // if there is a socket, then the session is active
                userSession.active = true;
                return userSession;
            }),
            'USER_SESSION'
        );
    }
    return {
        onUserConnect: (socket) => {
            const session = formatSession(socket);
            localUserSessions[session.origin] = session;
            session.active = true;
            logger.info('New user session');
            if (coreModule.publish) {
                coreModule.notifyCreation(session.tenantId, 'USER_SESSION', session);
            }
            if (onUserConnect) {
                onUserConnect(session);
            }
        },
        onUserDisconnect: (socket) => {
            const session = formatSession(socket);
            if (session) {
                session.active = false;
                if (coreModule.publish) {
                    session.active = false;
                    coreModule.notifyDelete(session.tenantId, 'USER_SESSION', session);
                }
                if (onUserDisconnect) {
                    onUserDisconnect(session);
                }
            }
        },
    };
}
/**
 * A session might be reactivated if the jwt token is not expired
 * if a session is inactive and its token has expired for sometime
 * It means this session is gone, and user will need to log in again
 *
 * Let's remember, a session might not become inactive because the socket got disconnected
 * it happens often on the web (ex browser put in the background can cause this),
 * but browser will reconnect at some point. it does not mean the user needs to relogin, just the session is inactive currently (and not receiving publication notification in real time)
 */
function _clearOldUserSessions(maxInactiveTimeForInactiveSession) {
    _.forEach(_.values(localUserSessions), (session) => {
        if (!session.active && moment.duration(moment(new Date()).diff(session.lastUpdate)).asMinutes()>maxInactiveTimeForInactiveSession) {
            delete localUserSessions[session.origin];
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
 * Provide the count of active sessions for provided user on this server
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

function formatSession(socket) {
    let session = localUserSessions[socket.origin];
  // new session? or user has changed at the origin (browser)?
    if (!session || session.userId !== socket.userId) {
        session = {
            id: socket.id,
            userId: socket.userId,
            origin: socket.origin,
            zervServerId: service.getServerInstanceId(),
            tenantId: socket.tenantId,
            creation: socket.creation,
            payload: socket.payload,
            revision: 0
        };
    } else {
        session.id = socket.id;
        session.revision++;
    }
    session.lastUpdate = new Date();
    return session;
}
