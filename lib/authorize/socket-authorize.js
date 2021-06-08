const _ = require('lodash');
const zlog = require('zimit-zlog');
const blackListService = require('../token-blacklist.service');
const userSessionService = require('../user-session.service.js');
const jwt = require('jsonwebtoken');
const { verifyJwtToken } = require('./authorize.helper');
const UnauthorizedError = require('./UnauthorizedError');

const logger = zlog.getLogger('zerv/core/socket-authorize');


/**
 * This middleware role is:
 * - Create an authenticated connection via socket
 * - Ensure to maintain a secure connection (token refresh) and prevent reuse of valid token
 * - Handle logout request
 *
 * @param {Object} options
 * @property {Number} options.timeout this is max duration in ms to provide a token after a socket connection
 * @property {Number} options.tokenRefreshIntervalInMins this is max duration of a token before it is refreshed
 * @property {Number} options.inactiveLocalUserSessionTimeoutInMins this is max socket disconnection duration before all resources
 *                                                            (such as removing of all subscription states, calling of onLocalUserSessionDestroy, etc)
 *                                                            bound to its local user session are released from this server memory.
 *                                                            If session is restablished later on, all subscriptions requested by the client will pull their data again.
 *                                                            by default, 5 minutes
 * @param {SocketIoServer} io This is the socketio server instance
 * @param {Object} coreModule This is zerv module instance
 * @returns {Function} that handles new socket connnection
 */
function socketAuthorize(authOptions, io, coreModule) {
    const options = _.assign({}, authOptions, {
        inactiveLocalUserSessionTimeoutInMins: authOptions.inactiveLocalUserSessionTimeoutInMins || 5,
        timeout: authOptions.timeout || 5000,
        tokenRefreshIntervalInMins: authOptions.tokenRefreshIntervalInMins || (24 * 60)
    });
    userSessionService.init(coreModule, io, options.inactiveLocalUserSessionTimeoutInMins);
    logger.info('Web socket middleware initialized  - token refresh interval: %s mins, socket authentication timeout: %s millisecs, inactive local user session timeout: %s mins', options.tokenRefreshIntervalInMins, options.timeout, options.inactiveLocalUserSessionTimeoutInMins);
    return onNewSocket;


    function onNewSocket(socket) {
        const authTimeout = setAuthorizationTimeout(socket, options.timeout);
        // ..................................
        // The authentication logic is currently based on a similar old logic used
        // in the socketio-jwt lib (it could be another reason for deprecating this lib).
        //
        // This could be improved by not using authenticate event.
        // -> currently, the socket client (the browser app) must connect the socket, then authenticate by passing the token.
        //
        // The client should be re-implemented to send the token via the request header instead - which is encrypted by https.
        // The backend would directly process the token during socket initialization to avoid a round trip via authenticate.
        // A new event/logic would also need to be created to handle the token refresh for the client to obtain it.
        //
        // This could not only simply the code on front end and backend but also avoid extra communication and complexity/reliability during reconnection process.
        // ..................................
        socket.on('authenticate', function(data) {
            clearTimeout(authTimeout);
            authenticateSocket(socket, data);
        });

        // let's listen on logout
        socket.on('logout', function(token) {
            if (!socket.origin) {
                // the socket is not established yet.
                return;
            }
            socket.emit('logged_out', 'user_logged_out');
            userSessionService.logout(socket.origin, 'user_logged_out');
        });

        socket.on('disconnect', function(err) {
            clearTimeout(authTimeout);
            // Potential errors
            // ----------------
            // transport errorServer SideTransport error
            // server namespace disconnect Server Side Server performs a socket.disconnect()
            // client namespace disconnect Client Side Got disconnect packet from client
            // ping timeout Client Side Client stopped responding to pings in the allowed amount of time (per the pingTimeout config setting)
            // transport close Client Side Client stopped sending data
            userSessionService.disconnectUser(socket, err);
        });

        // When then user is active on the UI, the backend is notified.
        socket.on('activity', (logMsg) => {
            userSessionService.notifyUserSessionActivity(socket.origin, logMsg);
        });
    }

    /**
     * This function is called each time the client attempts to authenticate on the currently open socket.
     *
     * @param {Object} socket
     * @param {Object} connData
     */
    async function authenticateSocket(socket, data) {
        try {
            const connData = _.clone(data);
            connData.decodedToken = await verifyJwtToken(connData.token, options);
            // a new socket might be created when browser reconnects after period of inactivity (ex: phone went to stand by and connect at times in the background)
            if (!socket.userId) {
                await initNewConnectionAuthorization(socket, connData);
                return;
            }
            if (socket.userId !== connData.decodedToken.id) {
                // it is an existing connection
                // make sure a token created for a different user session is not used to maintain another user session
                throw new UnauthorizedError('unauthorized_token', { message: 'Unauthorized use of a token with this socket' });
            }
            await maintainExistingConnectionAuthorization(socket, connData);
        } catch (error) {
            emitUnauthorizedError(socket, error);
        }
    }

    /**
     * This function is called the first time the socket is authorized.
     *
     *
     * @param {Object} currentSocket
     * @param {Object} connData
     * @return {Promise<UserSession>}
     */
    async function initNewConnectionAuthorization(currentSocket, connData) {
        try {
            currentSocket.userId = connData.decodedToken.id;
            if (connData.origin) {
                invalidateAllSocketsAtThisOriginWhichAreNotRelatedToUser(currentSocket.server.sockets.sockets, connData.origin, currentSocket.userId);
            }
            if (_.isFunction(options.getTenantId) && _.isNil(currentSocket.tenantId)) {
                currentSocket.tenantId = await getTenantId(connData.decodedToken, options.getTenantId);
            }

            let oldTokenExp, newToken, payload;
            const oldToken = connData.token;
            // if it is not a new login
            if (isAuthCodeToken(connData.decodedToken)) {
                oldTokenExp = connData.decodedToken.exp;
                // the first token (jti = 0 ) must always be refreshed, since it is usually an auth code with a short life span
                [newToken, payload] = refreshToken(connData.decodedToken, connData.origin, currentSocket.tenantId);
            } else {
                await checkForValidUserSession(connData.origin);
                // No need to refresh the token, it is just a new connection from a network loss or an additional browser tab
                // ..................................
                // To dig in: if the token is close to get refreshed, a refreshed token could be sent instead;
                // However, If many tabs compete to reconnect at the same time\,
                // this could lead to revoked tokens and a tab triggering a full logout
                // ..................................
                oldTokenExp = null;
                newToken = oldToken;
                payload = connData.decodedToken;
            }
            // When the socket is created, the origin is defined so that it can be determined
            // which sockets are connected to the same origin
            // This is useful for knowing:
            // - the number of browser tabs are opened by a user
            // - Being able to log out all of them when the user logs out.
            currentSocket.origin = connData.origin || newToken;
            currentSocket.token = newToken;
            currentSocket.payload = payload;
            currentSocket.creation = new Date();

            emitToken(currentSocket, newToken, oldToken === newToken ? null : oldToken, oldTokenExp);
            return userSessionService.connectUser(currentSocket);
        } catch (error) {
            logger.info('Connection initialization error - %s', error.message);
            throw new UnauthorizedError(error.message, { message: 'Connection initialization error' });
        }
    }

    /**
     * This function is called each time the client requests refreshing the token
     *
     * @param {*} currentSocket
     * @param {*} connData
     */
    async function maintainExistingConnectionAuthorization(currentSocket, connData) {
        try {
            if (!currentSocket.origin) {
                // This would happen if the initNewConnection initated by a reconnection has not completed
                // but a token refresh (which might have been scheduled) is already requested!
                // No need to maintain or refresh anything. the initNewConnection will complete the job soon.
                return;
            }
            await checkForValidUserSession(currentSocket.origin);

            const [newToken, payload] = refreshToken(connData.decodedToken, connData.origin, currentSocket.tenantId);
            // every socket that is using the same token (comming from the same browser origin with multiple tabs opened), is now updated.
            _.forEach(currentSocket.server.sockets.sockets, function(socket) {
                if (socket.origin === currentSocket.origin) {
                    socket.payload = payload;
                    socket.token = newToken;
                }
            });
            emitToken(currentSocket, newToken, connData.token, connData.decodedToken.exp);
        } catch (error) {
            // Not display an error but rather info as this can happen during the life of the connection
            logger.info('Connection refresh error - %s', error.message);
            throw new UnauthorizedError(error.message, { message: 'Connection refresh error' });
        }
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

    function refreshToken(oldPayload, socketOrigin, tenantId) {
        const newPayload = _.clone(oldPayload);
        // this tracks how many times a token was refreshed
        newPayload.jti = newPayload.jti || 0;
        newPayload.jti += 1;

        let refreshedToken;
        // this will be used by the client to figure out when to refresh
        newPayload.dur = options.tokenRefreshIntervalInMins * 60;

        const currentExpirationInSeconds = newPayload.exp - newPayload.iat;
        const configExpirationInSeconds = userSessionService.getTenantMaximumActiveSessionTimeoutInMins(tenantId) * 60;
        if (currentExpirationInSeconds !== configExpirationInSeconds) {
            // the expiration needs recalculating based on the current duration and time
            delete newPayload.exp;
            // update iat, exp field of the payload (mutate is true)
            refreshedToken = jwt.sign(newPayload, options.secret, { expiresIn: configExpirationInSeconds, mutatePayload: true });
        } else {
            refreshedToken = jwt.sign(newPayload, options.secret);
        }

        const now = Math.floor(Date.now() / 1000);
        if (now > newPayload.exp) {
            // this could happen if the session timeout was decreased and a session was already opened
            logger.info('Token for User %s : refreshed %s time(s), created %s secs ago, but expired at %s, %s secs ago.', newPayload.display || newPayload.id, newPayload.jti, now - newPayload.iat, new Date(newPayload.exp * 1000), newPayload.exp - now);
            userSessionService.logout(socketOrigin, 'active_session_duration_decreased');
            throw new Error('active_session_duration_decreased');
        } else {
            logger.info('Token for User %s : refreshed %s time(s), created %s secs ago, expire at %s in %s secs.', newPayload.display || newPayload.id, newPayload.jti, now - newPayload.iat, new Date(newPayload.exp * 1000), newPayload.exp - now);
        }
        return [refreshedToken, newPayload];
    }

    function emitToken(socket, newToken, oldToken, oldTokenExp) {
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

    function emitUnauthorizedError(socket, error) {
        if (!error instanceof UnauthorizedError) {
            const code = 'unknown';
            error = new UnauthorizedError(code, {
                message: (Object.prototype.toString.call(error) === '[object Object]' && error.message) ? error.message : error
            });
        }
        socket.emit('unauthorized', error, function() {
            // this seems to never happen.. to investigate later on
            socket.disconnect('unauthorized');
        });
    }

    function setAuthorizationTimeout(socket, timeout) {
        return setTimeout(
            () => socket.disconnect('unauthorized'),
            timeout
        );
    }

    function isAuthCodeToken(decodedToken) {
    // the first token created should always be an auth code
    // which is a token with a short life span
        return !(decodedToken.jti >= 1);
    }

    async function checkForValidUserSession(origin) {
        if (!await userSessionService.isUserSessionActive(origin)) {
            userSessionService.logout(origin, 'inactive_session_timeout_or_session_not_found');
            // User session has already expired due to inactivity
            throw new Error('inactive_session_timeout_or_session_not_found');
        }
    }

    async function getTenantId(decodedToken, getTenantIdFn) {
        const tenantId = await getTenantIdFn(decodedToken);
        if (!tenantId) {
            throw new Error('unknown_tenant');
        }
        return tenantId;
    }
}

module.exports = socketAuthorize;
