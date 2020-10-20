const _ = require('lodash');
const socketioJwt = require('socketio-jwt');
const zlog = require('zimit-zlog');
const blackListService = require('./token-blacklist.service');
const userSessionService = require('./user-session.service.js');

const logger = zlog.getLogger('zerv/core/authorize');

/**
 * This middleware role is:
 * - Create an authenticated connection via socket
 * - Ensure to maintain a secure connection (token refresh) and prevent reuse of valid token
 * - Handle logout request
 *
 * @param {Object} options
 * @param {Number} options.tokenExpiresInMins this is max duration of a token
 * @param {Number} options.disposalInterval this is how often the removing the blacklisted token should happen
 * @param {Number} options.maxInactiveTimeInMinsForInactiveSession this is max duration for an inactive session before being destroyed and resources released.
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

    blackListService.scheduleTokenMaintenance(options.disposalInterval, options.tokenExpiresInMins);
    userSessionService.init(coreModule, io, options.maxInactiveTimeInMinsForInactiveSession || 10);

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
        // @ts-ignore
        return socketioJwt.authorize(options)(socket, onConnection);
    };


    // /////////////////////////////////////

    /**
       * This function is called each time the client attempts to authenticate on the currently open socket.
       *
       * @param {Object} decodedToken
       * @param {Function} onSuccess
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
                    onError('Connection initialization error', err.message);
                });
        }
        if (context.socket.userId !== decodedToken.id) {
            // it is an existing connection
            // make sure a token created for a different user session is not used to maintain another user session
            return onError('Unauthorized use of a token with this socket', 'unauthorized_token');
        }
        maintainConnection(decodedToken, context);
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
        const newToken = refreshToken(decodedToken, context.data.token, currentSocket.tenantId);

        // When the socket is created, the origin is defined so that it can be determined
        // which sockets are connected to the same origin
        // This is useful to know:
        // - the number of browser tabs are opened by a user
        // - and to be able to log out all of them when the user logs out.
        currentSocket.origin = context.data.origin || newToken;
        currentSocket.token = newToken;
        currentSocket.payload = decodedToken;
        currentSocket.creation = new Date();

        emitToken(newToken, oldToken, currentSocket);
        return userSessionService.connectUser(currentSocket);
    }


    /**
       * This function is called each time the client requests refreshing the token
       *
       * @param {*} decodedToken
       * @param {*} context
       */
    function maintainConnection(decodedToken, context) {
        const currentSocket = context.socket;
        const oldToken = context.data.token;
        const newToken = refreshToken(decodedToken, context.data.token, context.socket.tenantId);
        // every socket that is using the same token (comming from the same browser origin with multiple tabs opened), is now updated.
        _.forEach(currentSocket.server.sockets.sockets, function(socket) {
            if (socket.origin === currentSocket.origin) {
                socket.payload = decodedToken;
                socket.token = newToken;
            }
        });
        emitToken(newToken, oldToken, currentSocket);
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

    function emitToken(newToken, oldToken, socket) {
        logger.debug('Emit refreshed token %b to replaced %b.', newToken, oldToken);
        socket.emit('authenticated', newToken, (status) => {
            // the old token is still valid for a little time
            // Prevent anyone from reusing it to gain a valid access.
            // Be aware:
            // the new token must be received first before revoking the old one
            // if the network goes before the new token is acknowledged by the client
            // the token will not be revoked, so that when the client reconnects (before old token expiration)
            // it can still use the old token to reconnect.
            blackListService.revokeToken(oldToken);
        });
    }

    function refreshToken(payload, token, tenantId) {
        // this tracks how many times a token was refreshed
        if (payload.jti > 0) {
            payload.jti += 1;
        } else {
            payload.jti = 1;
        }
        // this will be used by the client to figure out when to refresh
        payload.dur = userSessionService.getTenantMaximumInactiveSessionTimeoutInMins(tenantId) * 60;

        const now = Math.floor(Date.now() / 1000);
        const exp = new Date();
        exp.setSeconds(exp.getSeconds(payload.dur));
        logger.info('Token for User %s : Last (#%s) was created %s secs ago and would expire in %s secs. New token will expire at %s in %s secs.', payload.display || payload.id, payload.jti, now - payload.iat, payload.exp - now, exp, payload.dur);

        // the iat (timestamp of when the token was created) cannot be taken in consideration.
        // a new value must be created by the refresh implementation based on date.now
        delete payload.iat;
        // the expiration needs recalculating based on the current duration and time
        delete payload.exp;
        // the refresh impl code must
        // update iat, exp field of the payload
        return options.refresh(payload, payload.dur);
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
