'use strict';
const assert = require('assert'),
    _ = require('lodash'),
    jwt = require('jsonwebtoken'),
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

const coreModule = {
    addModule,
    apiServe,
    apiRouter,
    socketServe,
    infraServe,
    infrastructure,
    httpAuthorize: authorize.httpAuthorize,
    transport
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
        .on('connection', authorize.socketAuthorize(options));

    io.listen(server);

    return io;

    // //////////////////////////////////////

    function generateDefaultSessionToken(payload) {
        payload.dur = options.tokenExpiresInMins * 60;
        return jwt.sign(payload, this.secret, {expiresIn: payload.dur});
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
    logger.info('Infrastructure Initialization: User access and api/socket middleware on same physical server.');

    apiServe(app, options);
    const so = socketServe(server, options);
    return apiRouter(so, options.api || 'api');
};


function apiRouter(io, event) {
    return new ApiRouter(io, event, transport, coreModule.defineTransaction);
}


