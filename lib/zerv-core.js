'use strict';
const assert = require('assert'),
    _ = require('lodash'),
    Promise = require('promise'),
    socketio_jwt = require('socketio-jwt'),
    jwt = require('jsonwebtoken'),
    SocketIoServer = require('socket.io'),
    zlog = require('zlog');

const Adapter = require('socket.io-adapter');

var authorize = require('./authorize')
var apiAccess = require('./api-access');
var apiRouter = require('./api-router');

var logger = zlog.getLogger('zerv/core');

let coreModule = {
    addModule,
    apiServe,
    apiRouter,
    socketServe,
    infraServe,
    infrastructure,
    httpAuthorize: authorize.httpAuthorize
};

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
        .on('connection', authorize.socketAuthorize(options));

    io.listen(server);

    return io;

    ////////////////////////////////////////

    function generateDefaultSessionToken(payload) {
        payload.dur = options.tokenExpiresInMins * 60;
        return jwt.sign(payload, this.secret, { expiresIn: payload.dur });
    }
};

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
    logger.info('Infrastructure Initialization: User access and api/socket middleware on same physical server.')

    apiServe(app, options);
    var so = socketServe(server, options);
    return apiRouter(so, options.api || 'api');
};


