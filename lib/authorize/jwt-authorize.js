const _ = require('lodash');
// const zlog = require('zimit-zlog');
const jwt = require('jsonwebtoken');
const xtend = require('xtend');

// const logger = zlog.getLogger('zerv/core/authorize');

function UnauthorizedError (code, error) {
    Error.call(this, error.message);
    this.message = error.message;
    this.inner = error;
    this.data = {
      message: this.message,
      code: code,
      type: "UnauthorizedError"
    };
  }
  
  UnauthorizedError.prototype = Object.create(Error.prototype);
  UnauthorizedError.prototype.constructor = UnauthorizedError;

function authorize(options) {
    var defaults = { required: true };
    options = xtend(defaults, options);
  
    return function (socket) {
      var server = this.server || socket.server;
  
      if (!server.$emit) {
        //then is socket.io 1.0
        var Namespace = Object.getPrototypeOf(server.sockets).constructor;
        if (!~Namespace.events.indexOf('authenticated')) {
          Namespace.events.push('authenticated');
        }
      }
  
      if(options.required){
        var auth_timeout = setTimeout(function () {
          socket.disconnect('unauthorized');
        }, options.timeout || 5000);
      }
  
      socket.on('authenticate', function (data) {
        if(options.required){
          clearTimeout(auth_timeout);
        }
        // error handler
        var onError = function(err, code) {
            if (err) {
              code = code || 'unknown';
              var error = new UnauthorizedError(code, {
                message: (Object.prototype.toString.call(err) === '[object Object]' && err.message) ? err.message : err
              });
              socket.emit('unauthorized', error, function() {
                socket.disconnect('unauthorized');
              });
              return; // stop logic, socket will be close on next tick
            }
        };
  
        if(typeof data.token !== "string") {
          return onError({message: 'invalid token datatype'}, 'invalid_token');
        }
  
        var onJwtVerificationReady = function(err, decoded) {
  
          if (err) {
            return onError(err, 'invalid_token');
          }
  
          // success handler
          var onSuccess = function() {
            socket.decoded_token = decoded;
            socket.emit('authenticated');
            if (server.$emit) {
              server.$emit('authenticated', socket);
            } else {
              //try getting the current namespace otherwise fallback to all sockets.
              var namespace = (server.nsps && socket.nsp &&
                               server.nsps[socket.nsp.name]) ||
                              server.sockets;
  
              // explicit namespace
              namespace.emit('authenticated', socket);
            }
          };
  
          if(options.additional_auth && typeof options.additional_auth === 'function') {
            options.additional_auth(decoded, onSuccess, onError, {socket: socket, data: data});
          } else {
            onSuccess();
          }
        };
  
        var onSecretReady = function(err, secret) {
          if (err || !secret) {
            return onError(err, 'invalid_secret');
          }
  
          jwt.verify(data.token, secret, options, onJwtVerificationReady);
        };
  
        getSecret(socket.request, options.secret, data.token, onSecretReady);
      });
    };
  }

  function getSecret(request, secret, token, callback) {
    if (typeof secret === 'function') {
      if (!token) {
        return callback({ code: 'invalid_token', message: 'jwt must be provided' });
      }
  
      var parts = token.split('.');
  
      if (parts.length < 3) {
        return callback({ code: 'invalid_token', message: 'jwt malformed' });
      }
  
      if (parts[2].trim() === '') {
        return callback({ code: 'invalid_token', message: 'jwt signature is required' });
      }
  
      var decodedToken = jwt.decode(token);
  
      if (!decodedToken) {
        return callback({ code: 'invalid_token', message: 'jwt malformed' });
      }
  
      secret(request, decodedToken, callback);
    } else {
      callback(null, secret);
    }
  };




module.exports = authorize;
