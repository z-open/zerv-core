const _ = require('lodash');
const socketioJwt = require('socketio-jwt');
const zlog = require('zimit-zlog');
const blackListService = require('./token-blacklist.service');
const userSessionService = require('./user-session.service.js');
const jwt = require('jsonwebtoken');


const logger = zlog.getLogger('zerv/core/authorize');

/**
 * This middleware role is:
 * - Create an authenticated connection via socket
 * - Ensure to maintain a secure connection (token refresh) and prevent reuse of valid token
 * - Handle logout request
 *
 * @param {Object} options
 * @property {Number} options.tokenRefreshIntervalInMins this is max duration of a token before it is refreshed
 * @property {Number} options.inactiveLocalUserSessionTimeoutInMins this is max socket disconnection duration before all resources
 *                                                            (such as removing of all subscription states, calling of onLocalUserSessionDestroy, etc)
 *                                                            bound to its local user session are released from this server memory.
 *                                                            If session is restablished later on, all subscriptions requested by the client will pull their data again.
 *                                                            by default, 5 minutes
 *
 * @param {SocketIoServer} io
 * @param {Object} coreModule
 * @param {Function} onConnection
 * @returns {Function} that handles new socket connnection
 */
function socketAuthorize(options, io, coreModule, onConnection) {
    // no querystring
    options = _.assign(
        {required: true, additional_auth: authorizeWithAuthCodeAndRefreshedToken, handshake: false},
        options
    );

    userSessionService.init(coreModule, io, options.inactiveLocalUserSessionTimeoutInMins || 5);

    logger.info('Web socket middleware initialized  - token refresh interval: %s mins, socket authentication timeout: %s millisecs, inactive local user session timeout: %s mins', options.tokenRefreshIntervalInMins, options.timeout, options.inactiveLocalUserSessionTimeoutInMins);

    return function(socket) {
        // let's listen on logout
        socket.on('logout', function(token) {
            if (!socket.origin) {
                // the socket is not established yet.
                return;
            }
            userSessionService.logout(socket.origin, 'user_logged_out');
        });
        socket.on('disconnect', function(err) {
            // Note: do not remove. Potential errors:
            // transport errorServer SideTransport error
            // server namespace disconnect Server Side Server performs a socket.disconnect()
            // client namespace disconnect Client Side Got disconnect packet from client
            // ping timeout Client Side Client stopped responding to pings in the allowed amount of time (per the pingTimeout config setting)
            // transport close Client Side Client stopped sending data
            userSessionService.disconnectUser(socket, err);
        });
        // when user is active on the UI, it is notified.
        socket.on('activity', function(logMsg) {
            userSessionService.notifyUserSessionActivity(socket.origin, logMsg);
        });
        // @ts-ignore
        return socketioJwt.authorize(options)(socket, onConnection);
    };


    // /////////////////////////////////////

    /**
       * This function is called each time the client attempts to authenticate on the currently open socket.
       *
       * @param {Object} decodedToken
       * @param {Function} onSuccess which will not be used since the emit of 'authenticated' will be done directly
       * @param {Function} onError
       * @param {Object} context
       */
    async function authorizeWithAuthCodeAndRefreshedToken(decodedToken, onSuccess, onError, context) {
        // when the token is used once, a refreshed token is sent back. the old one is black listed (set as refreshed)
        // are we receiving again a token that we have already refreshed once?
        if (await blackListService.isTokenRevoked(context.data.token)) {
            return onError('Token is no longer valid', 'no_longer_valid');
        }
        // a new socket might be created when browser reconnects after period of inactivity (ex: phone went to stand by and connect at times in the background)
        if (!context.socket.userId) {
            return initNewConnection(decodedToken, context)
                .catch(function(err) {
                    // Not display an error but rather info as this can happen during the life of the connection
                    logger.info('Connection initialization error - %s', err.message);
                    onError('Connection initialization error', err.message);
                });
        }
        if (context.socket.userId !== decodedToken.id) {
            // it is an existing connection
            // make sure a token created for a different user session is not used to maintain another user session
            return onError('Unauthorized use of a token with this socket', 'unauthorized_token');
        }
        return maintainConnection(decodedToken, context)
            .catch(function(err) {
                // Not display an error but rather info as this can happen during the life of the connection
                logger.info('Connection refresh error - %s', err.message);
                onError('Connection refresh error', err.message);
            });
    }

    /**
       * This function is called the first time the socket is authorized.
       *
       *
       * @param {String} decodedToken could be a decoded access code or a token
       * @param {Object} context
       * @return {Promise<UserSession>}
       */
    async function initNewConnection(decodedToken, context) {
        const currentSocket = context.socket;
        const oldToken = context.data.token;
        currentSocket.userId = decodedToken.id;

        if (context.data.origin) {
            invalidateAllSocketsAtThisOriginWhichAreNotRelatedToUser(currentSocket.server.sockets.sockets, context.data.origin, currentSocket.userId);
        }

        if (_.isFunction(options.getTenantId) && _.isNil(currentSocket.tenantId)) {
            currentSocket.tenantId = await options.getTenantId(decodedToken);
            if (!currentSocket.tenantId) {
                throw new Error('unknown_tenant');
            }
        }
        // if it is not a new login
        let oldTokenExp = null;
        if (decodedToken.jti >=1) {
            if (!await userSessionService.isUserSessionActive(context.data.origin)) {
                userSessionService.logout(context.data.origin, 'inactive_session_timeout_or_session_not_found');
                // User session has already expired due to inactivity
                throw new Error('inactive_session_timeout_or_session_not_found');
            }
            // no need to refresh the token, it is just a new connection from a network loss or a new tab
            newToken = oldToken;
        } else {
            oldTokenExp = decodedToken.exp;
            // decodedToken will be mutated!!!
            newToken = refreshToken(decodedToken, context.data.origin, currentSocket.tenantId);
        }


        // When the socket is created, the origin is defined so that it can be determined
        // which sockets are connected to the same origin
        // This is useful to know:
        // - the number of browser tabs are opened by a user
        // - and to be able to log out all of them when the user logs out.
        currentSocket.origin = context.data.origin || newToken;
        currentSocket.token = newToken;
        currentSocket.payload = decodedToken;
        currentSocket.creation = new Date();

        emitToken(newToken, oldToken === newToken ? null : oldToken, oldTokenExp, currentSocket);
        return userSessionService.connectUser(currentSocket);
    }


    /**
       * This function is called each time the client requests refreshing the token
       *
       * @param {*} decodedToken
       * @param {*} context
       */
    async function maintainConnection(decodedToken, context) {
        if (!context.socket.origin) {
            // This would happen if the initNewConnection initated by a reconnection has not completed
            // but a token refresh (which might have been scheduled) is already requested!
            // No need to maintain or refresh anything. the initNewConnection will complete the job soon.
            return;
        }
        const currentSocket = context.socket;
        const oldToken = context.data.token;

        if (!await userSessionService.isUserSessionActive(currentSocket.origin)) {
            userSessionService.logout(context.data.origin, 'inactive_session_timeout_or_session_not_found');
            // User session has already expired due to inactivity
            throw new Error('inactive_session_timeout_or_session_not_found');
        }

        const newToken = refreshToken(decodedToken, context.data.origin, context.socket.tenantId);
        // every socket that is using the same token (comming from the same browser origin with multiple tabs opened), is now updated.
        _.forEach(currentSocket.server.sockets.sockets, function(socket) {
            if (socket.origin === currentSocket.origin) {
                socket.payload = decodedToken;
                socket.token = newToken;
            }
        });
        emitToken(newToken, oldToken, decodedToken.exp, currentSocket);
    }

    /**
       * This emits a refresh event to all client sockets from the same origin (same browser but different tabs opened on zimit)
       *
       * @param {*} allSockets
       * @param {*} origin
       * @param {*} userId
       */
    function invalidateAllSocketsAtThisOriginWhichAreNotRelatedToUser(allSockets, origin, userId) {
        _.forEach(allSockets, function(socket) {
            if (socket.origin === origin && userId !== socket.userId) {
                socket.emit('unauthorized', 'wrong_user');
            }
        });
    }

    function emitToken(newToken, oldToken, oldTokenExp, socket) {
        logger.debug('Emit token %b%s.', newToken.substr(-10), oldToken ? ' to refresh ' + oldToken.substr(-10) : '');
        socket.emit('authenticated', newToken, (status) => {
            // the old token is still valid for a little time
            // Prevent anyone from reusing it to gain a valid access.
            // Be aware:
            // the new token must be received first before revoking the old one
            // if the network goes before the new token is acknowledged by the client
            // the token will not be revoked, so that when the client reconnects (before old token expiration)
            // it can still use the old token to reconnect.
            if (oldToken) {
                blackListService.revokeToken(oldToken, oldTokenExp);
            }
        });
    }

    function refreshToken(payload, socketOrigin, tenantId) {
        // this tracks how many times a token was refreshed
        payload.jti = payload.jti || 0;
        payload.jti += 1;

        let refreshedToken;
        // this will be used by the client to figure out when to refresh
        payload.dur = options.tokenRefreshIntervalInMins * 60;

        const currentExpirationInSeconds = payload.exp - payload.iat;
        const configExpirationInSeconds = userSessionService.getTenantMaximumActiveSessionTimeoutInMins(tenantId) * 60;
        if (currentExpirationInSeconds !== configExpirationInSeconds) {
            // the expiration needs recalculating based on the current duration and time
            delete payload.exp;
            // update iat, exp field of the payload (mutate is true)
            refreshedToken = jwt.sign(payload, options.secret, {expiresIn: configExpirationInSeconds, mutatePayload: true});
        } else {
            refreshedToken = jwt.sign(payload, options.secret);
        }

        const now = Math.floor(Date.now() / 1000);
        if (now > payload.exp) {
            // this could happen if the session timeout was decreased and a session was already opened
            logger.info('Token for User %s : refreshed %s time(s), created %s secs ago, but expired at %s, %s secs ago.', payload.display || payload.id, payload.jti, now - payload.iat, new Date(payload.exp * 1000), payload.exp - now);
            userSessionService.logout(socketOrigin, 'active_session_duration_decreased');
            throw new Error('active_session_duration_decreased');
        } else {
            logger.info('Token for User %s : refreshed %s time(s), created %s secs ago, expire at %s in %s secs.', payload.display || payload.id, payload.jti, now - payload.iat, new Date(payload.exp * 1000), payload.exp - now);
        }
        return refreshedToken;
    }
}

/**
 * Check Authorization of a http request.
 *
 * Reuse the socket authorize implementation for now.
 *
 * @param {*} options
 * @param {*} req
 * @param {*} res
 *
 * @returns {Promise} which resolves with the following object on success
 *    { payload,newToken}
 */
function httpAuthorize(options, req) {
    const p = new Promise(function(resolve, reject) {
        const data = _.assign({token: req.headers['access-token']}, req,
            {
                server: {$emit},
                emit,
                on,
                disconnect: _.noop
            });

        socketioJwt.authorize(options)(
            data
        );

        function $emit(event, resp) {
            if (event === 'authenticated') {
                resolve({
                    payload: resp.decoded_token,
                    newToken: 'not implemented'
                });
            }
        }

        function emit(event, resp) {
            if (event === 'unauthorized') {
                logger.info('Unauthorized access %b to %b', resp.message, req.url);
                reject(resp);
            }
        }

        function on(event, onCallback) {
            if (event === 'authenticate') {
                onCallback(data);
            }
        }
    });
    return p;
}


module.exports = {
    socketAuthorize,
    httpAuthorize
};
