const _ = require('lodash');
const jwtAuthorize = require('./jwt-authorize');
const zlog = require('zimit-zlog');
const blackListService = require('../token-blacklist.service');
const userSessionService = require('../user-session.service.js');
const jwt = require('jsonwebtoken');
const UnauthorizedError = require('./UnauthorizedError');

const logger = zlog.getLogger('zerv/core/socket-authorize');

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
 * @param {SocketIoServer} io
 * @param {Object} coreModule
 * @param {Function} onConnection
 * @returns {Function} that handles new socket connnection
 */
function socketAuthorize(options, io, coreModule, onConnection) {
  userSessionService.init(coreModule, io, options.inactiveLocalUserSessionTimeoutInMins || 5);

  logger.info('Web socket middleware initialized  - token refresh interval: %s mins, socket authentication timeout: %s millisecs, inactive local user session timeout: %s mins', options.tokenRefreshIntervalInMins, options.timeout, options.inactiveLocalUserSessionTimeoutInMins);

  return (socket) => {
    const auth_timeout = setAuthorizationTimeout(socket, options);
    // this could be improved by not using authenticate event
    // and directly process token at socket initialization
    // to avoid a round trip. 
    // a new event could be created to handle the token refresh if client needed to request it
    socket.on('authenticate', function (data) {
      clearTimeout(auth_timeout);
      authenticateSocket(socket, data);
    });

    // let's listen on logout
    socket.on('logout', function (token) {
      if (!socket.origin) {
        // the socket is not established yet.
        return;
      }
      userSessionService.logout(socket.origin, 'user_logged_out');
    });

    socket.on('disconnect', function (err) {
      clearTimeout(auth_timeout);
      // Note: do not remove. Potential errors:
      // transport errorServer SideTransport error
      // server namespace disconnect Server Side Server performs a socket.disconnect()
      // client namespace disconnect Client Side Got disconnect packet from client
      // ping timeout Client Side Client stopped responding to pings in the allowed amount of time (per the pingTimeout config setting)
      // transport close Client Side Client stopped sending data
      userSessionService.disconnectUser(socket, err);
    });

    // when user is active on the UI, it is notified.
    socket.on('activity', function (logMsg) {
      userSessionService.notifyUserSessionActivity(socket.origin, logMsg);
    });
  };

  // /////////////////////////////////////

  /**
     * This function is called each time the client attempts to authenticate on the currently open socket.
     *
     * @param {Object} socket
     * @param {Object} data
     */
  async function authenticateSocket(socket, data) {
    try {
      const decodedToken = verifyJwtToken(data.token, options);
      // when the token is used once, a refreshed token is sent back. the old one is black listed (set as refreshed)
      // are we receiving again a token that we have already refreshed once?
      if (await blackListService.isTokenRevoked(data.token)) {
        throw new UnauthorizedError('no_longer_valid', {message: 'Token is no longer valid'});
      }
      // a new socket might be created when browser reconnects after period of inactivity (ex: phone went to stand by and connect at times in the background)
      if (!socket.userId) {
        return await initNewConnection(socket, decodedToken, data);
      }
      if (socket.userId !== decodedToken.id) {
        // it is an existing connection
        // make sure a token created for a different user session is not used to maintain another user session
        throw new UnauthorizedError('unauthorized_token', {message: 'Unauthorized use of a token with this socket'});
      }
      return await maintainConnection(socket, decodedToken, data);
    } catch (error) {
      emitUnauthorizedError(socket, error);
    }
  }

  function setAuthorizationTimeout(socket, options) {
    return setTimeout(
      () => {
        socket.disconnect('unauthorized');
      }, 
      options.timeout || 5000
    );
  }

  function verifyJwtToken(token, options) {
    if (!options.secret) {
      throw new UnauthorizedError('invalid_secret', {message: 'Secret is not provided'});
    }
    try {
      return jwt.verify(token, options.secret, options);
    } catch (err) {
      throw new UnauthorizedError('no_longer_valid', {message: 'Token is no longer valid'});
    }
  }

  function emitUnauthorizedError(socket, error) {
    if (!error instanceof UnauthorizedError) {
      code = code || 'unknown';
      error = new UnauthorizedError(code, {
        message: (Object.prototype.toString.call(error) === '[object Object]' && error.message) ? error.message : error
      });
    }
    socket.emit('unauthorized', error, function () {
      socket.disconnect('unauthorized');
    });
  }

  /**
     * This function is called the first time the socket is authorized.
     *
     *
     * @param {Object} currentSocket
     * @param {String} decodedToken could be a decoded access code or a token
     * @param {Object} data
     * @return {Promise<UserSession>}
     */
  async function initNewConnection(currentSocket, decodedToken, data) {
    try {
      const oldToken = data.token;
      currentSocket.userId = decodedToken.id;

      if (data.origin) {
        invalidateAllSocketsAtThisOriginWhichAreNotRelatedToUser(currentSocket.server.sockets.sockets, data.origin, currentSocket.userId);
      }
      if (_.isFunction(options.getTenantId) && _.isNil(currentSocket.tenantId)) {
        currentSocket.tenantId = await getTenantId(decodedToken, options.getTenantId);
      }
      // if it is not a new login
      let oldTokenExp, newToken;
      if (decodedToken.jti >= 1) {
        if (!await userSessionService.isUserSessionActive(data.origin)) {
          userSessionService.logout(data.origin, 'inactive_session_timeout_or_session_not_found');
          // User session has already expired due to inactivity
          throw new Error('inactive_session_timeout_or_session_not_found');
        }

        // No need to refresh the token, it is just a new connection from a network loss or a new tab
        // However if its iat (creation) + auth_token_expires_in_min > than current time
        // Which would mean that the token was NOT refreshed on time when socket reconnected
        // then we might consider throwing an error as extra security. or just rely on inactivity timeout

        oldTokenExp = null;
        newToken = oldToken;
        payload = decodedToken;
      } else {
        oldTokenExp = decodedToken.exp;
        [newToken, payload] = refreshToken(decodedToken, data.origin, currentSocket.tenantId);
      }
      // When the socket is created, the origin is defined so that it can be determined
      // which sockets are connected to the same origin
      // This is useful to know:
      // - the number of browser tabs are opened by a user
      // - and to be able to log out all of them when the user logs out.
      currentSocket.origin = data.origin || newToken;
      currentSocket.token = newToken;
      currentSocket.payload = payload;
      currentSocket.creation = new Date();

      emitToken(newToken, oldToken === newToken ? null : oldToken, oldTokenExp, currentSocket);
      return userSessionService.connectUser(currentSocket);

    } catch (err) {
      // Not display an error but rather info as this can happen during the life of the connection
      logger.info('Connection initialization error - %s', err.message);
      throw new UnauthorizedError(err.message, {message: 'Connection initialization error'});
    }
  }

  /**
     * This function is called each time the client requests refreshing the token
     *
     * @param {*} currentSocket
     * @param {*} decodedToken
     * @param {*} data
     */
  async function maintainConnection(currentSocket, decodedToken, data) {
    try {
      if (!currentSocket.origin) {
        // This would happen if the initNewConnection initated by a reconnection has not completed
        // but a token refresh (which might have been scheduled) is already requested!
        // No need to maintain or refresh anything. the initNewConnection will complete the job soon.
        return;
      }
      const oldToken = data.token;

      if (!await userSessionService.isUserSessionActive(currentSocket.origin)) {
        userSessionService.logout(data.origin, 'inactive_session_timeout_or_session_not_found');
        // User session has already expired due to inactivity
        throw new Error('inactive_session_timeout_or_session_not_found');
      }

      const [newToken, payload] = refreshToken(decodedToken, data.origin, currentSocket.tenantId);
      // every socket that is using the same token (comming from the same browser origin with multiple tabs opened), is now updated.
      _.forEach(currentSocket.server.sockets.sockets, function (socket) {
        if (socket.origin === currentSocket.origin) {
          socket.payload = payload;
          socket.token = newToken;
        }
      });
      emitToken(newToken, oldToken, decodedToken.exp, currentSocket);

    } catch (err) {
      // Not display an error but rather info as this can happen during the life of the connection
      logger.info('Connection refresh error - %s', err.message);
      throw new UnauthorizedError(err.message, {message: 'Connection refresh error'});
    }
  }

  async function getTenantId(decodedToken, getTenantIdFn) {
    const tenantId = await getTenantIdFn(decodedToken);
    if (!tenantId) {
      throw new Error('unknown_tenant');
    }
    return tenantId;
  }
  /**
     * This emits a refresh event to all client sockets from the same origin (same browser but different tabs opened on zimit)
     *
     * @param {*} allSockets
     * @param {*} origin
     * @param {*} userId
     */
  function invalidateAllSocketsAtThisOriginWhichAreNotRelatedToUser(allSockets, origin, userId) {
    _.forEach(allSockets, function (socket) {
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
    return [ refreshedToken, newPayload ];
  }
}

module.exports = socketAuthorize;
