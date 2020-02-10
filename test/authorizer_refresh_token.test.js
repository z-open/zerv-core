const fixture = require('./fixture');
const request = require('request');
const io = require('socket.io-client');
const should = require('should');
const jwt = require('jsonwebtoken');
const zlog = require('zlog4js');

zlog.setLogger('socketio-auth', 'NONE');

describe('TEST: authorizer with auth code and refresh tokens', function() {
    let options;
    // start and stop the server
    before(function(done) {
        options = {
            refresh: function(decoded) {
                return jwt.sign(decoded, this.secret, {expiresIn: 10});
            },
            claim: function(user) {
                return user;
            },
            tokenExpiresInMins: 10

        };
        fixture.start(options, done);
    });

    after(fixture.stop);

    beforeEach(function(done) {
        // otherwise test might create similar tokens (based on now())
        options.clearBlackList();
        done();
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
                    socket.on('authenticated', function(refreshToken) {
                        should.exist(refreshToken);
                        token.should.not.eql(refreshToken);
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
                    socket.on('authenticated', function(refreshToken) {
                        should.exist(refreshToken);
                        token.should.not.eql(refreshToken);
                        socket.close();


                        // now trying a new connection but with the same token
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', function() {
                            socket2.on('unauthorized', function(err) {
                                // console.log("error" + JSON.stringify(err));
                                socket2.close();
                                err.message.should.eql('Token is no longer valid');
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
                    socket.on('authenticated', function(refreshToken) {
                        should.exist(refreshToken);
                        token.should.not.eql(refreshToken);
                        socket.close();
                        // now trying a new connection but with the same token
                        const socket2 = io.connect('http://localhost:9000', {
                            'forceNew': true,
                        });
                        socket2.on('connect', function() {
                            socket2.on('authenticated', function(newRefreshedToken) {
                                // console.log("error" + JSON.stringify(err));
                                socket2.close();

                                // now we try to use the first refreshToken again!
                                const socket3 = io.connect('http://localhost:9000', {
                                    'forceNew': true,
                                });
                                socket3.on('connect', function() {
                                    socket3.on('unauthorized', function(err) {
                                        // console.log("error" + JSON.stringify(err));
                                        socket3.close();
                                        err.message.should.eql('Token is no longer valid');
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
                    socket.on('authenticated', function(refreshToken) {
                        should.exist(refreshToken);
                        token.should.not.eql(refreshToken);
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
                    socket.on('authenticated', function(refreshToken) {
                        should.exist(refreshToken);
                        token.should.not.eql(refreshToken);
                        refreshedToken = refreshToken;
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
                                err.message.should.eql('Token is no longer valid');
                                done();
                            }).emit('authenticate', {token: refreshedToken});
                        });
                    }).emit('authenticate', {token: token});
                });
            });
        });
    });

    // when the black listed token is about to expire, inform client to authenticate so that it can record a new refreshed token..

    // could we be less intrusive and code all the login...  additional_auth...not sure...if not good enough


    describe('Http authentication', function() {
        it('should authorize and return a token', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: {'username': 'jose', 'password': 'Pa123', 'grant_type': 'rest'},
                json: true
            }, function(err, resp, body) {
                should.exist(body.access_token);
                body.url.should.eql('restServer/');
                resp.statusCode.should.eql(200);
                done();
            });
        });

        it('should reject invalid credentials', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: {'username': 'jose', 'password': 'wrong', 'grant_type': 'rest'},
                json: true
            }, function(err, resp, body) {
                should.exist(body.code);
                body.code.should.eql('USER_INVALID');
                resp.statusCode.should.eql(401);
                done();
            });
        });

        it('should reject invalid request', (done) => {
            request.post({
                url: 'http://localhost:9000/authorize',
                body: {'username': 'jose', 'password': 'wrong', 'grant_type': 'unknown'},
                json: true
            }, function(err, resp, body) {
                should.exist(body.code);
                body.code.should.eql('INVALID_TYPE');
                resp.statusCode.should.eql(400);
                done();
            });
        });
    });
});
