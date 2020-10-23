'use strict';
const assert = require('assert'),
    _ = require('lodash'),
    SocketIoServer = require('socket.io'),
    zJsonBin = require('zjsonbin'),
    zlog = require('zimit-zlog');

const authorize = require('./authorize');
const apiAccess = require('./api-access');
const ApiRouter = require('./api-router');
const transactionService = require('./transaction.service');
const userSessionService = require('./user-session.service');
const cacheService = require('./cache.service');
const serverActivityService = require('./server-activity.service');


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
    transport,

    // cache api
    getRedisClient: cacheService.getRedisClient,
    isClusterEnabled: cacheService.isClusterCacheEnabled,
    cacheData: cacheService.cacheData,
    removeCachedData: cacheService.removeCachedData,
    getCachedData: cacheService.getCachedData,
    getCachedBooleanValue: cacheService.getCachedData,
    getCachedObject: cacheService.getCachedObject,

    // user session api
    isLocalUserSession: userSessionService.isLocalUserSession,
    countLocalSessionsByUserId: userSessionService.countLocalSessionsByUserId,
    isUserSessionServerOrigin: userSessionService.isLocalUserSession,
    getLocalUserSessions: userSessionService.getLocalUserSessions,
    onLocalUserSessionDestroy: userSessionService.onLocalUserSessionDestroy,
    setTenantMaximumActiveSessionTimeout: userSessionService.setTenantMaximumActiveSessionTimeout,
    getTenantMaximumActiveSessionTimeoutInMins: userSessionService.getTenantMaximumActiveSessionTimeoutInMins,
    setTenantMaximumInactiveSessionTimeout: userSessionService.setTenantMaximumInactiveSessionTimeout,
    getTenantMaximumInactiveSessionTimeoutInMins: userSessionService.getTenantMaximumInactiveSessionTimeoutInMins,

    isServerShutDownInProgress: serverActivityService.isServerPaused,
    shutdown,
    stopLocalServer,
    getActivitiesInProcess: serverActivityService.getActivitiesInProcess,
    registerNewActivity: serverActivityService.registerNewActivity
};

transactionService.init(coreModule);

module.exports = coreModule;

function addModule(name, module) {
    logger.debug('Add %b module.', name);
    _.assign(coreModule, module);
}

/**
 * Stop the local server from creating new activities
 * @param {Number} delayInSecs before not accepting new activities
 */
async function stopLocalServer(delayInSecs) {
    await serverActivityService.pause(delayInSecs);
}

/**
 * Shutdown and exit the server after all current activities currently in progress completed.
 * @param {Number} delayBeforeShuttingdown  is the delay before not accepting new activities
 * @param {Number} exitDelay is the delay after stopping all activies before exiting
 */
async function shutdown(delayBeforeShuttingdown = 5, exitDelay = 5) {
    await serverActivityService.pause(delayBeforeShuttingdown);
    setTimeout(() => {
        console.info('shutdown single zerv infrastructure completed');
        process.exit();
    }, exitDelay * 1000);
}

/**
 *
 * Create a socketio server with middleware to handle token based socket connection.
 *
 * @param {Server} server this node http or https server
 * @param {Object} options
 * @param {Number} options.tokenRefreshIntervalInMins this is when the token is supposed to be refreshed
 * @param {Number} options.disposalInterval this is how often the removing the blacklisted token should occur
 * @param {Number} options.maxInactiveTimeInMinsForInactiveSession this is max duration for an inactive session before being destroyed and resources released.
 * @param {Function} options.claim this function receives a user object and generates the content of the token payload
 * @param {String} options.secret this is the secret phrase to sign and verify a token
 * @param {Function} options.refresh this function receives a payload object and generates the token. By default a function is provided which uses JWT sign.
 * @param {Function} options.getTenantId this function receives a payload object and uses its data (such as user Id) to figure out the tenantId. TenantId should never be stored in a token.
 *
 * @returns {SocketIoServer} a new instance of the socketIo server
 *
 */
function socketServe(server, options) {
    assert(options.claim);
    assert.notStrictEqual(options.findUserByCredentials, undefined);

    options.tokenRefreshIntervalInMins = options.tokenRefreshIntervalInMins ? Number(options.tokenRefreshIntervalInMins) : 5;

    const io = new SocketIoServer();
    io.sockets
      .on('connection', authorize.socketAuthorize(options, io, coreModule));
    io.listen(server);
    return io;
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
