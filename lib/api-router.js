const Promise = require('promise'),
    zlog = require('zlog'),
    extend = require('util')._extend;

var logger = zlog.getLogger('zerv/api/router');

/**
 * Middleware managing Api calls 
 * 
 * Socket server will listen to only one event name and then will dispatch the specified api call to its implementation.
 * 
 * 
 */

function apiRouter(io, event) {
    var events = {};
    io.on('connection', onEvent);
    var api = {
        on: on
    };
    return api;

    //////////////////////////////////
    /**
     *  use this service method to provide the code for your api call.
     *  the code can return a promise or some data.
     * @param call: name of your api call
     * @param handler: code to run when the api is called
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
    function on(call, handler) {
        events[call] = handler;
        // so that we can daisy chain: on.on.on
        return api;
    }

    /**
     * listen to the socket and run the requested api call.
     * format the response with the data or error before sending back the caller.
     */
    function onEvent(socket) {
        socket.on(event, function (call, data, fn) {
            handle(socket, call, data)
                .then(function (data) {
                    fn({ code: 0, data: data });
                })
                .catch(function (err) {
                    fn(formatErrorResponse(call, err));
                });
        });
    }

    /**
     * execute the requested api call
     */
    function handle(socket, call, params) {
        if (!socket.payload) {
            return Promise.reject({ code: 'UNAUTHORIZED', description: 'Access requires authentication' });
        }

        logCall(socket.payload, 'calling Api [' + call + ']');
        var func = events[call];
        if (!func) {
            return Promise.reject({ code: 'API-UNKNOWN', description: 'Unknown API call [' + call + ']' });
        }
        return new Handler(socket, func).execute(params);
    };

    /**
     * format error to send back to the client
     */
    function formatErrorResponse(call, err) {
        // logic errors thrown with a code and description, or could be custom error object (from a throw or reject)
        if (err.description) {
            logger.error(call + ' -> Error [' + err.code + ']: ' + err.description);
            return { code: err.code, data: err.description };
        }

        // internal error... (coming from a throw inside a promise)
        if (err.stack) {
           logger.error(call + ' -> Error [' + err.code + ']',err.stack);
            return {
                code: err.code || 'SERVER_ERROR',
                data: 'Backend error while API call [' + call + ']'
            };
        }

        // logic error string provided from reject (with a string)
        logger.error(call + ' -> Error [' + err + ']');
        return { code: err };
    }

    /**  
     * This object runs the api code.
     * 
     * Thanks to this object, the api code will have access to the connected user data as well as the emit and broadcast functions.
     * 
     */
    function Handler(socket, func) {
        this.exe = func;

        this.user = extend({}, socket.payload);  // protect original object from modification.
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

        var handler = this;

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
            socket.emit(event, data);
        }

        function log(text) {
            logCall(handler.user, text);
        }

        function execute(params) {
            var result;
            try {
                result = this.exe(params);
                // any result is wrapped in a promise if it is not already
                result = Promise.resolve(result);
            }
            catch (e) {
                result = Promise.reject(e);
                //log(e);
                // result = Promise.reject({
                //     code: 'INTERNAL_ERROR',
                //     stack: e.stack
                // });
            }
            return result;
        }
    };

    function logCall(user, text) {
        logger.info(user.display + ': ' + text);
    }
};


module.exports = apiRouter;

