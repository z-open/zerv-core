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

describe('Socket authorize', () => {
    let options;
    const codeExpiresInSecs= 20;

    // start and stop the server
    beforeAll((done) => {
        options = {
            timeout: 1500, // to complete authentication. from socket connection to authentication
            codeExpiresInSecs,
            tokenRefreshIntervalInMins: 2, // this is when the token will get refreshed

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
        cacheService._disableLocalCacheFilePersistence();

        startServer(options, done);
    });

    afterAll(stopServer);

    beforeEach(() => {
        spyOn(userSessionService, 'getTenantMaximumActiveSessionTimeoutInMins').and.returnValue(24 * 60);
        // otherwise test might create similar tokens (based on now())
        cacheService._clearLocalCache();
        userSessionService._clearLocalUserSessions();
    });
    afterEach((done) => {
        // give enough time to zerv to close all sockets opened during a test
        setTimeout(done, 50);
    });

    describe('Middleware', () => {
        describe('when the user is not logged in', () => {
            it('should close the connection after a timeout if no auth message is received', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    forceNew: true
                });
                socket.once('disconnect', () => {
                    done();
                });
            });

            it('should not respond echo', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });

                socket.on('echo-response', () => {
                    done(new Error('this should not happen'));
                }).emit('echo', { hi: 123 });

                setTimeout(done, 1200);
            });

            it('should not connect with a bad token', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });

                socket.on('connect', () => {
                    socket.on('authenticated', () => done.fail('should NOT have been authenticated'));
                    socket.on('unauthorized', (error) => {
                        expect(error.message).toBe('Token is invalid');
                        expect(error.data.code).toBe('invalid_token');
                        done();
                    });
                    socket.emit('authenticate', { token: 'badtoken' });
                });

                setTimeout(done, 1200);
            });
        });

        describe('when the user is logged in', () => {
            let authToken;

            beforeEach((done) => {
                request.post({
                    url: 'http://localhost:9000/authorize',
                    body: { 'username': 'jose', 'password': 'Pa123', 'grant_type': 'login' },
                    json: true
                }, (err, resp, body) => {
                    if (err) {
                        throw err;
                    }
                    authToken = body.access_token;
                    done();
                });
            });

            it('should do the handshake and connect and receive a token with different expiration values', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                const authPayload = jwt.decode(authToken);
                expect(authPayload.exp - authPayload.iat).toBe(20);

                socket.on('connect', () => {
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
                        socket.emit('authenticate', { token: authToken });
                    }, 1100);
                });
            });


            it('should connect, refresh token and make the auth token invalid', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                socket.on('connect', () => {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
                        fnAck();
                        socket.close();


                        // now trying a new connection but with the same token
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', () => {
                            socket2.on('unauthorized', function(err) {
                                // console.log("error" + JSON.stringify(err));
                                socket2.close();
                                expect(err.message).toBe('Token was revoked');
                                expect(err.data.code).toBe('revoked_token');
                                done();
                            }).emit('authenticate', { token: authToken });
                        });
                    }).emit('authenticate', { token: authToken });
                });
            });


            it('should connect, refresh token and make the refreshed token invalid', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                socket.on('connect', () => {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
                        fnAck();
                        socket.close();
                        // now trying a new connection but with the same token
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', () => {
                            socket2.on('authenticated', function(newRefreshedToken, fnAck2) {
                                // console.log("error" + JSON.stringify(err));
                                fnAck2();
                                socket2.close();

                                // now we try to use the first refreshToken again!
                                const socket3 = io.connect('http://localhost:9000', {
                                    'forceNew': true,
                                });
                                socket3.on('connect', () => {
                                    socket3.on('unauthorized', function(err) {
                                        // console.log("error" + JSON.stringify(err));
                                        socket3.close();
                                        expect(err.message).toBe('Connection initialization error');
                                        // the origin was incorrect no session was not found
                                        expect(err.data.code).toBe('inactive_session_timeout_or_session_not_found');
                                        done();
                                    });
                                    // when socket3 might not be coming from the same origin (hacker?)
                                    socket3.emit('authenticate', { token: refreshToken, origin: 'someotherPc' });
                                });
                            });
                            // when socket2 connect with the auth code, it will receive a refresh token
                            // this is the token that will be used to track the origin of the connection which is the browser.
                            socket2.emit('authenticate', { token: refreshToken, origin: refreshToken });
                        });
                    });
                    socket.emit('authenticate', { token: authToken });
                });
            });

            it('should connect, refresh token and then logout', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                socket.on('connect', () => {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
                        fnAck();
                        socket.emit('logout', refreshToken);
                    }).on('logged_out', () => {
                        socket.close();
                        done();
                    }).emit('authenticate', { token: authToken });
                });
            });


            it('should prevent reconnecting with same token after logout', (done) => {
                const socket = io.connect('http://localhost:9000', {
                    'forceNew': true,
                });
                let refreshedToken;

                socket.on('connect', () => {
                    socket.on('authenticated', function(refreshToken, fnAck) {
                        expect(refreshToken).toBeDefined();
                        expect(authToken).not.toBe(refreshToken);
                        refreshedToken = refreshToken;
                        fnAck();
                        socket.emit('logout', refreshToken);
                    }).on('logged_out', () => {
                        socket.close();

                        // now we try to use the refreshToken again!
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', () => {
                            socket2.on('unauthorized', function(err) {
                                // console.log("error" + JSON.stringify(err));
                                socket2.close();
                                expect(err.message).toBe('Connection initialization error');
                                // the origin was incorrect no session was not found
                                expect(err.data.code).toBe('inactive_session_timeout_or_session_not_found');
                                done();
                            }).emit('authenticate', { token: refreshedToken, origin: refreshedToken });
                        });
                    }).emit('authenticate', { token: authToken });
                });
            });
        });
    });

});


function startServer(options, callback) {
    options.restUrl = () => {
        return 'restServer/';
    };
    options.appUrl = () => {
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
