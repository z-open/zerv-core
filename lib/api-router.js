'use strict';

const _ = require('lodash');
const zlog = require('zimit-zlog');
const serverActivityService = require('./server-activity.service');

const logger = zlog.getLogger('zerv/api/router');

/**
 * Middleware managing Api calls
 *
 * Socket server will listen to only one event name and then will dispatch the specified api call to its implementation.
 *
 *
 */

function ApiRouter(io, event, transport, startTransaction) {
    const routes = {};

    io.on('connection', onEvent);
    const api = {
        on,
        io,
    };
    return api;

  // ////////////////////////////////
  /**
     *  use this service method to provide the code for your api call.
     *  the code can return a promise or some data.
     * @param {String} call: name of your api call
     * @param {Function} handler: code to run when the api is called
     * @param {Object} options is used to set options
     *       - Transactional to true, let know the transaction implementation to begin a transaction when the api is called
     *
     * ex:
     * api.on("news.myMessages", apiCode)
     *
     * function apiCode(max) {
     *   return db.loadMessagesOfUserId(this.userId,max)
     * }
     *
     * Notice that you can access in your api code the following data:
     * - this.userId
     * - this.user: return the socket payload, which should contain the user and more data as defined in your instantiation of socketio.auth
     * - this.broadcast(event,params): to broadcast an event with its params to others clients
     * - this.emit(event, params): to emit to this socket client
     */
    function on(call, handler, options) {
        logger.debug('Add api-route %b', call);
        routes[call] = {handler, options};
    // so that we can daisy chain: on.on.on
        return api;
    }

  /**
     * listen to the socket and run the requested api call.
     * format the response with the data or error before sending back the caller.
     */
    function onEvent(socket) {
        socket.on(event, function(call, serializedData, fn) {
            if (serverActivityService.isServerPaused()) {
                return sendResponse(formatErrorResponse(call, {code: 'SERVER_UNAVAILABLE'}));
            }
            let data;
            if (!_.isNil(serializedData)) {
                try {
                    data = transport.deserialize(serializedData);
                } catch (err) {
                    err.code = 'Incorrect data format';
                    return sendResponse(formatErrorResponse(call, err));
                }
            }

            const apiCall = serverActivityService.registerNewActivity(call, {tenantId: socket.tenantId}, {origin: 'zerv api'});

            handle(socket, call, data)
            .then(function(data) {
                logger.debug('Sending response to call %b', call);
                sendResponse({code: 0, data: data});
                apiCall.done();
            })
            .catch(function(err) {
                apiCall.fail(err);
                sendResponse(formatErrorResponse(call, err));
            });

            function sendResponse(data) {
                const resp = transport.serialize(data);
                fn(resp);
            }
        });
    }

  /**
     * execute the requested api call
     */
    async function handle(socket, call, params) {
        if (!socket.payload) {
      // eslint-disable-next-line no-throw-literal
            throw {code: 'UNAUTHORIZED', description: 'Access requires authentication'};
        }

        logger.info('%s: calling Api %b', socket.payload.display, call);
        const route = routes[call];
        if (!route || !route.handler) {
      // eslint-disable-next-line no-throw-literal
            throw {code: 'API-UNKNOWN', description: 'Unknown API call [' + call + ']'};
        }
        const options = _.assign(
            {transactional: false},
            route.options
        );
        return new Handler(socket, route.handler, options).execute(params);
    };

  /**
     * format error to send back to the client
     */
    function formatErrorResponse(call, err) {
    // logic errors thrown with a code and description, or could be custom error object (from a throw or reject)
        if (err.description) {
            if (err.stack) {
                logger.error('%s -> Error %b: %s', call, err.code, err.description, err.stack);
            } else {
                logger.error('%s -> Error %b: %s', call, err.code, err.description);
            }
            return {code: err.code, data: err.description};
        }

    // internal error... (most likely coming from a throw inside a promise)
        if (err.stack) {
            logger.error('%s -> Error: %b', call, err.code, err.stack);
            return {
                code: err.code || 'SERVER_ERROR',
                data: 'Backend error while API call [' + call + ']'
            };
        }

    // logic error string provided from reject (with a string)
        logger.error('%s -> Error %b', call, err);
        return {code: err};
    }

  /**
     * This object runs the api code.
     *
     * Thanks to this object, the api code will have access to the connected user data as well as the emit and broadcast functions.
     *
     */
    function Handler(socket, func, options) {
        this.exe = func;

        this.user = _.assign({}, socket.payload); // protect original object from modification.
        this.userId = this.user.id;
        if (socket.tenantId) {
      // make sure we have the tenant in the user for the handler.
            this.user.tenantId = socket.tenantId;
        }
        this.execute = execute;
        this.broadcast = broadcast;
        this.broadcastAll = broadcastAll;
        this.emit = emit;
        this.log = log;

        this.io = io;
        this.socket = socket;

        const handler = this;
        let trans;

        Object.defineProperty(this, 'transaction', {
            get: getTransaction
        });

        function getTransaction() {
            if (!trans) {
                trans = startTransaction({
                    name: 'Api Router',
                    user: this.user,
                    tenantId: this.user.tenantId
                });
            }
            return trans;
        }

    /**
         * broadcast to all connected clients, except the one connected to this socket
         */
        function broadcast(event, data) {
            socket.broadcast.emit(event, data);
        }

    /**
         * broadcast to all connected clients, even the one connected to this socket
         */
        function broadcastAll(event, data) {
            io.emit(event, data);
        }

    /** emit to the client connected to this socket
         *
         */
        function emit(event, data) {
      // Function seems not used in any lib???
            const serializedJson = transport.serialize(data);
            socket.emit(event, serializedJson);
        }

        function log(text) {
            logger.info('%s: %s', handler.user.display, text);
        }

    // function execute(params) {
    //     const thisHandler = this;
    //     try {
    //         const result = thisHandler.exe(params);
    //         // any result is wrapped in a promise if it is not already
    //         return Promise.resolve(result);
    //     } catch (e) {
    //         return Promise.reject(e);
    //     }
    // }

        function execute(params) {
            const thisHandler = this;
            if (options.transactional) {
                return getTransaction().then(() => thisHandler.exe(params));
            }
            try {
                const result = thisHandler.exe(params);
        // any result is wrapped in a promise if it is not already
                return Promise.resolve(result);
            } catch (e) {
                return Promise.reject(e);
            }
        }
    };
};

module.exports = ApiRouter;

