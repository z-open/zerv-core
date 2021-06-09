const express = require('express');
const http = require('http');
const zervCore = require('../lib/zerv-core');

const enableDestroy = require('server-destroy');
const bodyParser = require('body-parser');


const request = require('request');
const jwt = require('jsonwebtoken');
const zlog = require('zimit-zlog');

const cacheService = require('../lib/cache.service');
const userSessionService = require('../lib/user-session.service');
const httpAuthorize = require('../lib/authorize/http-authorize');

let server, socketIo;
zlog.setLogger('ZERV-CORE', 'ALL');

describe('Http Authorize', () => {
    let options;
    const codeExpiresInSecs= 20;

    // start and stop the server
    beforeAll((done) => {
        options = {
            codeExpiresInSecs,
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

    describe('authentication', () => {
        it('should authorize and return a token', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: { 'username': 'jose', 'password': 'Pa123', 'grant_type': 'rest' },
                json: true
            }, function(err, resp, body) {
                if (err) {
                    throw err;
                }
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
                body: { 'username': 'jose', 'password': 'wrong', 'grant_type': 'rest' },
                json: true
            }, function(err, resp, body) {
                if (err) {
                    throw err;
                }
                expect(body.code).toBeDefined();
                expect(body.code).toBe('USER_INVALID');
                expect(resp.statusCode).toBe(401);
                done();
            });
        });

        it('should reject invalid request', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: { 'username': 'jose', 'password': 'wrong', 'grant_type': 'unknown' },
                json: true
            }, function(err, resp, body) {
                if (err) {
                    throw err;
                }
                expect(body.code).toBeDefined();
                expect(body.code).toBe('INVALID_TYPE');
                expect(resp.statusCode).toBe(400);
                done();
            });
        });
    });

    describe('middleware', () => {
        let accessToken;

        beforeEach((done) => {
            jasmine.clock().install();
            jasmine.clock().mockDate(new Date());

            request.post({
                url: 'http://localhost:9000/authorize',
                body: { 'username': 'jose', 'password': 'Pa123', 'grant_type': 'rest' },
                json: true
            }, async (err, resp, body) => {
                if (err) {
                    done.fail('preparation should not have failed');
                }
                accessToken = body.access_token;
                done();
            });
        });

        afterEach(() => {
            jasmine.clock().uninstall();;
        });

        it('should accept the token', async () => {
            const req = {
                url: '/someUrl',
                headers: {
                    'access-token': accessToken
                }
            };
            // it is not expired yet
            jasmine.clock().tick(codeExpiresInSecs * 1000 - 1000);
            const result = await httpAuthorize(options, req);
            expect(result).toEqual({
                payload: jasmine.any(Object),
                newToken: 'not implemented'
            });

            const payload = result.payload;
            expect(payload.iat).toBeDefined();
            expect(payload.exp).toBeDefined();
            expect(payload.exp - payload.iat).toBe(20);
        });

        it('should reject the expired token', async () => {
            const req = {
                url: '/someUrl',
                headers: {
                    'access-token': accessToken
                }
            };
            console.info(new Date());
            jasmine.clock().tick(codeExpiresInSecs * 1000 + 100);
            try {
                await httpAuthorize(options, req);
                throw new Error('should have failed');
            } catch (err) {
                expect(err).toEqual(new Error('Token is invalid'));
            }
        });

        it('should reject the bad token', async () => {
            const req = {
                url: '/someUrl',
                headers: {
                    'access-token': 'BAD_TOKEN'
                }
            };
            console.info(new Date());
            jasmine.clock().tick(1200000 + 100);
            try {
                await httpAuthorize(options, req);
                throw new Error('should have failed');
            } catch (err) {
                expect(err).toEqual(new Error('Token is invalid'));
            }
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
