'use strict';
const assert = require('assert'),
    _ = require('lodash'),
    jwt = require('jsonwebtoken'),
    UUID = require('uuid'),
    SocketIoServer = require('socket.io'),
    zJsonBin = require('zjsonbin'),
    zlog = require('zlog4js');

const authorize = require('./authorize');
const apiAccess = require('./api-access');
const ApiRouter = require('./api-router');
const transaction = require('./transaction');


const logger = zlog.getLogger('zerv/core');

// this contains functions to serialize/deserialize json
// other libs will use it. by default use zJsonLib. Client should use the same transport object.
const transport = _.assign({}, zJsonBin);

const zervServerId = UUID.v4();

const coreModule = {
    addModule,
    apiServe,
    apiRouter,
    socketServe,
    infraServe,
    infrastructure,
    httpAuthorize: authorize.httpAuthorize,
    transport,

    isLocalUserSession,
    countLocalSessionsByUserId,
    isUserSessionServerOrigin,
    getLocalUserSessions
};

transaction.init(coreModule);

module.exports = coreModule;

function addModule(name, module) {
    logger.debug('Add %b module.', name);
    _.assign(coreModule, module);
}

/**
 *
 * create a socketio server with middleware to handle token based connection, reconnection
 *
 * return a new instance of the socketIo server
 *
 */
function socketServe(server, options) {
    assert.notStrictEqual(options.claim, undefined);
    assert.notStrictEqual(options.findUserByCredentials, undefined);

    if (!options.refresh) {
        options.refresh = generateDefaultSessionToken;
        options.tokenExpiresInMins = options.tokenExpiresInMins ? Number(options.tokenExpiresInMins) : 5;
    }

    if (!options.claim) {
        options.claim = generateClaim;
    }

    const io = new SocketIoServer();

    io.sockets
      .on('connection', authorize.socketAuthorize(
          options,
          getSessionEvents(io, options.onUserConnect, options.onUserDisconnect)
      ));

    io.listen(server);

    return io;

  // //////////////////////////////////////

    function generateDefaultSessionToken(payload) {
        payload.dur = options.tokenExpiresInMins * 60;
        return jwt.sign(payload, this.secret, {expiresIn: payload.dur});
    }
};


function getSessionEvents(io, onUserConnect, onUserDisconnect) {
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

const localUserSessions = {};

// Do not remove yet as this will need to be implemented;
// function purgeSessions(io) {
//     _.forEach(sessions, (session) => {
//         if (session has no existing sockets and session lastUpdate is more than 24 hrs), delete sessions from cache to free reseources
//         the session creation should be stored in the payload and not the socket, so that we know when the user logs in
//     });
// }

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
    return userSession.zervServerId === zervServerId;
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
            zervServerId,
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

/**
 * add to express app the login and registration api request handling.
 */
function apiServe(app, options) {
    return apiAccess(app, options);
}

/**
 * sugar function that sets up a secure socket server and provide api on the same server
 * Deprecated
 * return a new instance of the socketIo server
 */
function infrastructure(server, app, options) {
    apiServe(app, options);
    return socketServe(server, options);
};

/**
 * sugar function that sets up a secure socket server and provide access (login/registration) api on the same server
 *
 * return a new instance of the api-router
 */
function infraServe(server, app, options) {
    logger.info('Infrastructure Initialization: User access and api/socket middleware on same physical server.');

    apiServe(app, options);
    const so = socketServe(server, options);
    return apiRouter(so, options.api || 'api');
};


function apiRouter(io, event) {
    return new ApiRouter(io, event, transport, coreModule.defineTransaction);
}


