const xtend = require('xtend'),

    socketioJwt = require('socketio-jwt'),
    zlog = require('zlog');

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
            socket.emit('logged_out');
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

        if (!options.getTenantId) {
            emitNewToken(decoded, context);
        } else {
            // retrieve the optional tenantId based on payload information and store it for later use in the socket.
            options.getTenantId(decoded)
                .then(function(tenantId) {
                    if (!tenantId) {
                        // due to db issue most likely (user with no tenant!)
                        return onError('Tenant is invalid', 'invalid_tenant');
                    }
                    context.socket.tenantId = tenantId;
                    emitNewToken(decoded, context);
                })
                .catch(function() {
                    // if we don't find the tenant (db issue most likely)
                    return onError('Tenant is invalid', 'invalid_tenant');
                });
        }
    }

    function emitNewToken(decoded, context) {
        let newToken = refreshToken(decoded, context.data.token);
        logger.debug('Emit refreshed token %b to replaced %b.', newToken, context.data.token);
        context.socket.payload = decoded;
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
