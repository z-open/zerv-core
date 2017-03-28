/**
 * 
 * this configure an express app to handle login and register requests
 * 
 * and will return a token or a url to the client 
 * 
 * options are the following
 * 
 * authorization: a function that return a token, if not provided.
 *  uses by default generateAuthorizationCode function. but you would have to pass options.secret
 * 
 * claim: a function that receives the user as a parameter. this will return this information that will be the payload to generate the token
 */
const assert = require('assert'),
    jwt = require('jsonwebtoken'),
    socketIo = require('socket.io'),
    zlog = require('zlog');

var logger = zlog.getLogger('zerv/api/access')

module.exports = function (app, options) {

    assert.notStrictEqual(options.claim, undefined);
    assert.notStrictEqual(options.findUserByCredentials, undefined);

    if (!options.authorization) {
        options.authorization = generateDefaultAuthorizationCode;
        options.codeExpiresInSecs = options.codeExpiresInSecs ? Number(options.codeExpiresInSecs) : 5;
    }

    if (!options.claim) {
        options.claim = generateClaim;
    }

    app.post('/login', handleLoginRequest);

    app.post('/register', handleRegisterRequest);



    ////////////////////////////////////////

    function handleLoginRequest(req, res) {
        logger.info('check credentials for ' + JSON.stringify(req.body) + ', then send back auth code...');
        var user = options.findUserByCredentials(req.body)
            .then(function (user) {
                sendAuthorizationResponse(res, user);
            })
            .catch(function (err) {
                res.status(401).send({ code: err });
            });
    }

    function handleRegisterRequest(req, res) {
        logger.info('Registering ' + JSON.stringify(req.body) + ', then send back auth code...');

        options.register(req.body)
            .then(function (user) {
                sendAuthorizationResponse(res, user);
            })
            .catch(function (err) {
                //  Bad Request :The server cannot or will not process the request due to an apparent client error (e.g., malformed request syntax, invalid request message framing, or deceptive request routing).
                res.status(400).send({ code: err });
            });
    }

    function sendAuthorizationResponse(res, user) {
        var token = options.authorization(options.claim(user));
        if (options.appUrl) {
            res.status(200).send(options.appUrl(token));
        } else {
            res.json({ token: token });
        }
    }

    function generateDefaultAuthorizationCode(payload) {
        return jwt.sign(payload, options.secret, {
            expiresIn: options.codeExpiresInSecs
        });
    }


};

