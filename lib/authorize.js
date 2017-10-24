const xtend = require('xtend'),
    socketioJwt = require('socketio-jwt'),
    zlog = require('zlog'),
    _ = require('lodash');

const logger = zlog.getLogger('zerv/core/authorize');
let blackList;

function socketAuthorize(options, onConnection) {
    // no querystring

    let checkIfTokenRefreshedInSharedDb, updateRefreshedTokenInSharedDb;

    const defaults = {required: true, additional_auth: authorizeWithAuthCodeAndRefreshedToken, handshake: false};


    if (options.refresh) {
        if (options.validTokenDb) {
            // just some thoughts, about having multiple nodes and ability to manage connecting on different server. but would need to think how the websocket will emit on different node...
            checkIfTokenRefreshedInSharedDb = options.validTokenDb.checkIfTokenRefreshed;
            updateRefreshedTokenInSharedDb = options.validTokenDb.updateRefreshedToken;
        } else {
            configureLocalBlackList();
        }
        scheduleTokenMaintenance();
    }

    options = xtend(defaults, options);

    return function(socket) {
        // let's listen on logout 
        socket.on('logout', function(token) {
            blackList[token] = true;
            _.forEach(socket.server.sockets.sockets, function(sock) {
                if (sock.origin === socket.origin) {
                    sock.emit('logged_out');
                }
            });
        });
        return socketioJwt.authorize(options)(socket, onConnection);
    };


    // /////////////////////////////////////

    function scheduleTokenMaintenance() {
        setTimeout(function() {
            logger.debug('Start token maintenance.');
            removeExpiredEventFromBlackList();
            scheduleTokenMaintenance();
        }, (options.disposalInterval || (60 * 5)) * 1000);
    }


    function removeExpiredEventFromBlackList() {
        // @TODO...we could work out of an ordered list to speed up the whole thing.
        let currentTime = (new Date().getTime() / 1000) | 0; // remove millis
        for (let token in blackList) {
            if (blackList[token].exp < currentTime) {
                logger.debug('Remove expired token from blackList.', token);
                delete blackList[token];
            }
        }
    }


    function authorizeWithAuthCodeAndRefreshedToken(decoded, onSuccess, onError, context) {
        // when the token is used once, a refreshed token is sent back. the old one is black listed (set as refreshed)
        // are we receiving again a token that we have already refreshed once? 
        if (options.refresh && checkIfTokenRefreshedInSharedDb(context.data.token)) {
            return onError('Token is no longer valid', 'no_longer_valid');
        }

        const currentSocket = context.socket;
        const currentUserId = decoded.id;

        if (!currentSocket.userId) {
            // it is a new socket connection
            currentSocket.userId = currentUserId;
            if (context.data.origin ) {
                refreshSocketsAtThisOriginWhichAreNotRelatedToUser(currentSocket.server.sockets.sockets, context.data.origin, currentUserId);
            }
        } else if (currentSocket.userId !== currentUserId) {
            // it is an existing connection
            // make sure a token created for a different user session is not used to maintain another user session
            return onError('Unauthorized use of a token with this socket', 'unauthorized_token');
        }

        if (currentSocket.tenantId || !options.getTenantId) {
            emitNewToken(decoded, context);
        } else {
            // retrieve the optional tenantId based on payload information and store it for later use in the socket.
            options.getTenantId(decoded)
                .then(function(tenantId) {
                    if (!tenantId) {
                        // due to db issue most likely (user with no tenant!)
                        return onError('Tenant is invalid', 'invalid_tenant');
                    }
                    currentSocket.tenantId = tenantId;
                    emitNewToken(decoded, context);
                })
                .catch(function() {
                    // if we don't find the tenant (db issue most likely)
                    return onError('Tenant is invalid', 'invalid_tenant');
                });
        }
    }

    /**
     * This emits a refresh event to all client sockets from the same origin (same browser but different tabs opened on zimit) 
     *  
     * @param {*} allSockets 
     * @param {*} origin 
     * @param {*} userId 
     */
    function refreshSocketsAtThisOriginWhichAreNotRelatedToUser(allSockets, origin, userId) {
        _.forEach(allSockets, function(socket) {
            if (socket.origin === origin && userId !== socket.userId) {
                socket.emit('unauthorized', 'wrong_user');
            }
        });
    }

    function emitNewToken(decoded, context) {
        const newToken = refreshToken(decoded, context.data.token);
        logger.debug('Emit refreshed token %b to replaced %b.', newToken, context.data.token);


        const currentSocket = context.socket;

        // When the socket is created, the origin is defined so that it can be determined if
        // which sockets are connected to the same origin
        // This is useful to know:
        // - the number of browser tabs are opened by a user
        // - and to be able to log out all of them when the user logs out.
        if (!currentSocket.origin) {
            currentSocket.origin = context.data.origin || newToken;
            currentSocket.payload = decoded;
            currentSocket.token = newToken;
        } else {
            // every socket that is using the same token (comming from the same browser origin with multiple tabs opened), is now updated.
            _.forEach(currentSocket.server.sockets.sockets, function(socket) {
                if (socket.origin === currentSocket.origin) {
                    socket.payload = decoded;
                    socket.token = newToken;
                }
            });
        }
        context.socket.emit('authenticated', newToken);
    }

    //     //try getting the current namespace otherwise fallback to all sockets.
    //     var namespace = (server.nsps && socket.nsp &&
    //         server.nsps[socket.nsp.name]) ||
    //         server.sockets;

    //     // explicit namespace
    //     namespace.emit('authenticated', socket);


    function refreshToken(decoded, token) {
        // console.log("decoded:" + JSON.stringify(decoded) + ", was" + token);
        // this would make each token unique and track how many times a token was refreshed
        if (decoded.jti > 0) {
            decoded.jti += 1;
        } else {
            decoded.jti = 1;
        }

        let newToken = options.refresh(decoded);
        // we must prevent that a yet valid token be reused if it were refreshed.
        // but keep track of when the other will expire so we can inform client to get a new one..
        updateRefreshedTokenInSharedDb(token, newToken);
        return newToken;
    }


    function configureLocalBlackList() {
        if (!blackList) {
            blackList = {};
        }
        checkIfTokenRefreshedInSharedDb = function(token) {
            let validity = blackList[token];
            return validity;// && validity.refreshed;
        };
        updateRefreshedTokenInSharedDb = function(previousToken, newToken) {
            blackList[previousToken] = true;
            blackList[newToken] = false;
        };
        // this method was created mostly for testing purposes to delete the blacklist between test
        options.clearBlackList = function() {
            blackList = {};
        };
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
    // var defaults = { required: true, additional_auth: authorizeWithAuthCodeAndRefreshedToken, handshake: false };

    // options = xtend(defaults, options);

    let p = new Promise(function(resolve, reject) {
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
