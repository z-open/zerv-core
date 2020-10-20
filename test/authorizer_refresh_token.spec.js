const express = require('express');
const http = require('http');
const zervCore = require('../lib/zerv-core');

const enableDestroy = require('server-destroy');
const bodyParser = require('body-parser');


const request = require('request');
const io = require('socket.io-client');
const jwt = require('jsonwebtoken');
const zlog = require('zimit-zlog');

const tokenBlacklistService = require('../lib/token-blacklist.service');
let server, socketIo;
zlog.setLogger('ZERV-CORE', 'ALL');

describe('TEST: authorizer with auth code and refresh tokens', function() {
    let options;
    // start and stop the server
    beforeAll(function(done) {
        options = {
            timeout: 1000, // to complete authentication. from socket connection to authentication
            codeExpiresInSecs: 10,
            refresh: function(decoded) {
                return jwt.sign(decoded, this.secret, {expiresIn: 10000});
            },
            claim: function(user) {
                return user;
            },
            tokenExpiresInMins: 10,
            secret: 'aaafoo super sercret',
            findUserByCredentials: function(user) {
                return new Promise(function(resolve, reject) {
                    if (user.password !== 'Pa123') {
                        /* eslint-disable prefer-promise-reject-errors */
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
            },
        };
        tokenBlacklistService._clearBlackList();
        startServer(options, done);
    });

    afterAll(stopServer);

    beforeEach(() => {
        // otherwise test might create similar tokens (based on now())
        tokenBlacklistService._clearBlackList();
    });
    afterEach((done) => {
        // give enough time to zerv to close all sockets opened during test
        setTimeout(done, 50);
    });

    describe('Socket authentication', function() {
        describe('when the user is not logged in', function() {
            it('should close the connection after a timeout if no auth message is received', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    forceNew: true
                });
                socket.once('disconnect', function() {
                    done();
                });
            });

            it('should not respond echo', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });

                socket.on('echo-response', function() {
                    done(new Error('this should not happen'));
                }).emit('echo', {hi: 123});

                setTimeout(done, 1200);
            });
        });

        describe('when the user is logged in', function() {
            beforeEach(function(done) {
                request.post({
                    url: 'http://localhost:9000/authorize',
                    body: {'username': 'jose', 'password': 'Pa123', 'grant_type': 'login'},
                    json: true
                }, function(err, resp, body) {
                    this.token = body.access_token;
                    done();
                }.bind(this));
            });


            it('should do the handshake and connect and receive a different token', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const token = this.token;
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(token).not.toBe(refreshToken);
                        fnAck();
                        socket.close();
                        done();
                    })
                        .emit('authenticate', {token: token});
                });
            });


            it('should connect, refresh token and make the auth token invalid', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const token = this.token;
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(token).not.toBe(refreshToken);
                        fnAck();
                        socket.close();


                        // now trying a new connection but with the same token
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', function() {
                            socket2.on('unauthorized', function(err) {
                                // console.log("error" + JSON.stringify(err));
                                socket2.close();
                                expect(err.message).toBe('Token is no longer valid');
                                done();
                            }).emit('authenticate', {token: token});
                        });
                    }).emit('authenticate', {token: token});
                });
            });


            it('should connect, refresh token and make the refreshed token invalid', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const token = this.token;
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(token).not.toBe(refreshToken);
                        fnAck();
                        socket.close();
                        // now trying a new connection but with the same token
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', function() {
                            socket2.on('authenticated', function(newRefreshedToken, fnAck2) {
                                // console.log("error" + JSON.stringify(err));
                                fnAck2();
                                socket2.close();

                                // now we try to use the first refreshToken again!
                                const socket3 = io.connect('http://localhost:9000', {
                                    'forceNew': true,
                                });
                                socket3.on('connect', function() {
                                    socket3.on('unauthorized', function(err) {
                                        // console.log("error" + JSON.stringify(err));
                                        socket3.close();
                                        expect(err.message).toBe('Token is no longer valid');
                                        done();
                                    }).emit('authenticate', {token: refreshToken});
                                });
                            }).emit('authenticate', {token: refreshToken});
                        });
                    }).emit('authenticate', {token: token});
                });
            });

            it('should connect, refresh token and then logout', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const token = this.token;
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(token).not.toBe(refreshToken);
                        fnAck();
                        socket.emit('logout', refreshToken);
                    }).on('logged_out', function() {
                        socket.close();
                        done();
                    }).emit('authenticate', {token: token});
                });
            });


            it('should prevent reconnecting with same token after logout', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const token = this.token;
                let refreshedToken;

                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(token).not.toBe(refreshToken);
                        refreshedToken = refreshToken;
                        fnAck();
                        socket.emit('logout', refreshToken);
                    }).on('logged_out', function() {
                        socket.close();

                        // now we try to use the refreshToken again!
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', function() {
                            socket2.on('unauthorized', function(err) {
                                // console.log("error" + JSON.stringify(err));
                                socket2.close();
                                expect(err.message).toBe('Token is no longer valid');
                                done();
                            }).emit('authenticate', {token: refreshedToken});
                        });
                    }).emit('authenticate', {token: token});
                });
            });
        });
    });

    describe('Http authentication', function() {
        it('should authorize and return a token', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: {'username': 'jose', 'password': 'Pa123', 'grant_type': 'rest'},
                json: true
            }, function(err, resp, body) {
                expect(body.access_token).toBeDefined();
                expect(body.url).toBe('restServer/');
                expect(resp.statusCode).toBe(200);
                done();
            });
        });

        it('should reject invalid credentials', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: {'username': 'jose', 'password': 'wrong', 'grant_type': 'rest'},
                json: true
            }, function(err, resp, body) {
                expect(body.code).toBeDefined();
                expect(body.code).toBe('USER_INVALID');
                expect(resp.statusCode).toBe(401);
                done();
            });
        });

        it('should reject invalid request', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: {'username': 'jose', 'password': 'wrong', 'grant_type': 'unknown'},
                json: true
            }, function(err, resp, body) {
                expect(body.code).toBeDefined();
                expect(body.code).toBe('INVALID_TYPE');
                expect(resp.statusCode).toBe(400);
                done();
            });
        });
    });
});


function startServer(options, callback) {
    options.restUrl = function() {
        return 'restServer/';
    };
    options.appUrl = function() {
        return 'appServer/';
    };

    const app = express();
    app.use(bodyParser.json());
    server = http.createServer(app);
    socketIo = zervCore.infrastructure(server, app, options);

    server.__sockets = [];
    server.on('connection', function(c) {
        server.__sockets.push(c);
    });
    server.listen(9000, callback);
    enableDestroy(server);
};

function stopServer(callback) {
    socketIo.close();
    try {
        server.destroy();
    } catch (er) { }
    callback();
};
