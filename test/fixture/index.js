var express = require('express');
var http = require('http');

var socketIo = require('socket.io');
var socketio_auth = require('../../lib/zerv-core');

var jwt = require('jsonwebtoken');

var xtend = require('xtend');
var bodyParser = require('body-parser');

var promise = require('promise');

var server, sio;
var enableDestroy = require('server-destroy');


var bodyParser = require('body-parser');

exports.start = function (options, callback) {

    if (typeof options == 'function') {
        callback = options;
        options = {};
    }

    options.secret = 'aaafoo super sercret';
    options.timeout = 1000;
    options.findUserByCredentials = function (user) {
        return new Promise(function (resolve, reject) {
            if (user.password !== 'Pa123') {
                return reject('USER_INVALID');
            }
            resolve(
                {
                    first_name: 'John',
                    last_name: 'Doe',
                    email: 'john@doe.com',
                    id: 123
                }

            );

        });
    };
    options.restUrl = function () {
        return 'restServer/';
    }
    options.appUrl = function () {
        return 'appServer/';
    }

    var app = express();
    app.use(bodyParser.json());
    server = http.createServer(app);


    sio = socketio_auth.infrastructure(server, app, options)

    // app.use(bodyParser.json());

    // app.post('/login', function(req, res) {
    //     var profile = {
    //         first_name: 'John',
    //         last_name: 'Doe',
    //         email: 'john@doe.com',
    //         id: 123
    //     };

    //     // We are sending the profile inside the token
    //     var token = jwt.sign(profile, options.secret, {
    //         expiresIn: 30
    //     });

    //     res.json({ token: token });
    // });

    //    server = http.createServer(app);

    //    sio = socketIo.listen(server);

    // no handshare
    // sio.sockets
    //     .on('connection', socketio_auth.authorize(options))
    //     .on('error', function(err) {
    //         console.log("ERROR: " + JSON.stringify(err));
    //     })
    //     .on('unauthorized', function(err) {
    //         console.log("UNAUTHORIZED: " + JSON.stringify(err));
    //     })
    //     .on('authenticated', function(socket) {
    //         // socket.on('echo', function (m) {
    //         //   socket.emit('echo-response', m);
    //         // });
    //     });


    server.__sockets = [];
    server.on('connection', function (c) {
        server.__sockets.push(c);
    });
    server.listen(9000, callback);
    enableDestroy(server);
};

exports.stop = function (callback) {
    sio.close();
    try {
        server.destroy();
    } catch (er) { }
    callback();
};