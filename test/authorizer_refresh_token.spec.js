const express = require('express');
const http = require('http');
const zervCore = require('../lib/zerv-core');

const enableDestroy = require('server-destroy');
const bodyParser = require('body-parser');


const request = require('request');
const io = require('socket.io-client');
const jwt = require('jsonwebtoken');
const zlog = require('zimit-zlog');

const cacheService = require('../lib/cache.service');
const userSessionService = require('../lib/user-session.service');

let server, socketIo;
zlog.setLogger('ZERV-CORE', 'ALL');

describe('TEST: authorizer with auth code and refresh tokens', function() {
    let options;
    // start and stop the server
    beforeAll(function(done) {
        options = {
            timeout: 1500, // to complete authentication. from socket connection to authentication
            codeExpiresInSecs: 20,
            tokenExpiresInMins: 2, // this when the token needs to be refreshed

            claim: function(user) {
                return user;
            },
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
        cacheService._clearLocalCache();
        // spyOn(userSessionService, 'getTenantMaximumInactiveSessionTimeoutInMins');
        // userSessionService.getTenantMaximumInactiveSessionTimeoutInMins.and.returnValue(2);

        spyOn(userSessionService, 'getTenantMaximumActiveSessionTimeoutInMins');
        userSessionService.getTenantMaximumActiveSessionTimeoutInMins.and.returnValue(24 * 60);

        startServer(options, done);
    });

    afterAll(stopServer);

    beforeEach(() => {
        // otherwise test might create similar tokens (based on now())
        cacheService._clearLocalCache();
    });
    afterEach((done) => {
        // give enough time to zerv to close all sockets opened during a test
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
            let authToken;

            beforeEach(function(done) {
                request.post({
                    url: 'http://localhost:9000/authorize',
                    body: {'username': 'jose', 'password': 'Pa123', 'grant_type': 'login'},
                    json: true
                }, function(err, resp, body) {
                    authToken = body.access_token;
                    done();
                });
            });

            it('should do the handshake and connect and receive a token with different expiration values', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const authPayload = jwt.decode(authToken);
                expect(authPayload.exp - authPayload.iat).toBe(20);

                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
                        const refreshedPayload = jwt.decode(refreshToken);
                        expect(refreshedPayload.dur).toBe(120);
                        // the active session duration is limited for this tenant to 24 hours
                        expect(refreshedPayload.exp - refreshedPayload.iat).toBe(24 * 60 * 60);
                        // the timestamp of the authCode would be the same for all subsequent token
                        // but the exp date will be based on the active session timeout
                        expect(refreshedPayload.iat).toBe(authPayload.iat);
                        expect(refreshedPayload.exp).not.toBe(authPayload.ext);
                        expect(refreshedPayload.jti).toBe(1);
                        fnAck();
                        socket.close();
                        done();
                    });
                    // let's wait a sec so that the iat can be different from the auth code
                    // but no more otherwise the authentication timeout (in options) will kick in.
                    setTimeout(() => {
                        socket.emit('authenticate', {token: authToken});
                    }, 1100);
                });
            });


            it('should connect, refresh token and make the auth token invalid', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
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
                            }).emit('authenticate', {token: authToken});
                        });
                    }).emit('authenticate', {token: authToken});
                });
            });


            it('should connect, refresh token and make the refreshed token invalid', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
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
                                        expect(err.message).toBe('Connection initialization error');
                                        // the origin was incorrect no session was not found
                                        expect(err.data.code).toBe('inactive_session_timeout_or_session_not_found');
                                        done();
                                    });
                                    // when socket3 might not be coming from the same origin (hacker?)
                                    socket3.emit('authenticate', {token: refreshToken, origin: 'someotherPc'});
                                });
                            });
                        // when socket2 connect with the auth code, it will receive a refresh token
                        // this is the token that will be used to track the origin of the connection which is the browser.
                            socket2.emit('authenticate', {token: refreshToken, origin: refreshToken});
                        });
                    });
                    socket.emit('authenticate', {token: authToken});
                });
            });

            it('should connect, refresh token and then logout', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
                        fnAck();
                        socket.emit('logout', refreshToken);
                    }).on('logged_out', function() {
                        socket.close();
                        done();
                    }).emit('authenticate', {token: authToken});
                });
            });


            it('should prevent reconnecting with same token after logout', function(done) {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                let refreshedToken;

                socket.on('connect', function() {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
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
                    }).emit('authenticate', {token: authToken});
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
                const authToken = body.access_token;
                expect(authToken).toBeDefined();
                expect(body.url).toBe('restServer/');
                expect(resp.statusCode).toBe(200);
                const payload = jwt.decode(authToken);
                expect(payload.iat).toBeDefined();
                expect(payload.exp).toBeDefined();
                expect(payload.exp - payload.iat).toBe(20);
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
