'use strict';
/**
 *
 * this configure an express app to handle login and register requests
 *
 * and will return a token or a url to the client
 *
 * options are the following:
 *
 * @param {Function} authorization(token): a function that return a token, if not provided.
 *  uses by default generateAuthorizationCode function. but you would have to pass options.secret
 *
 * @param {Function} claim(user): a function that receives the user as a parameter. this will return this information that will be the payload to generate the token
 */
const assert = require('assert'),
    _ = require('lodash'),
    jwt = require('jsonwebtoken'),
    zlog = require('zimit-zlog');

const logger = zlog.getLogger('zerv/api/access');

/**
 * This function configures and add middleware to express to manage user authentication
 *
 * @param {Object} app the express app object
 * @param {Object} options
 * @param {Number} options.codeExpiresInSecs this is max duration of a code token
 * @param {Function} options.claim this function receives a user object and generates the content of the token payload
 * @param {String} options.secret this is the secret phrase to sign and verify a token
 * @param {Function} options.authorization this function receives a payload object and generates the token. By default a function is provided which uses JWT sign.
 * @param {function} options.onLogin this function would be call during login with the user that has just logged in
 * @param {function} options.findUserByCredentials this function would be called during login with http post data
 *
 */
module.exports = function(app, options) {
    assert(options.claim);
    assert.notStrictEqual(options.findUserByCredentials, undefined);

    if (!options.authorization) {
        options.authorization = generateDefaultAuthorizationCode;
        options.codeExpiresInSecs = options.codeExpiresInSecs ? Number(options.codeExpiresInSecs) : 5;
    }

    app.post('/authorize', handleLoginRequest);
    app.post('/register', handleRegisterRequest);

  // //////////////////////////////////////

    async function handleLoginRequest(req, res) {
        if (req.body) {
            logger.info('checking credentials for %b', JSON.stringify(req.body.user));
        }

        if (req.body.grant_type !== 'login' && req.body.grant_type !== 'rest') {
            return res.status(400).send({code: 'INVALID_TYPE'});
        }
        try {
            const user = await options.findUserByCredentials(req.body);
            if (_.isFunction(options.onLogin)) {
        // Note: Remove req.session, req, res in the future. what's the value?
                await options.onLogin(user, req.session, req, res);
            }
            sendAuthorizationResponse(res, user, req.body.grant_type);
        } catch (err) {
            res.status(401).send({code: err});
        };
    }

    function handleRegisterRequest(req, res) {
        logger.info('Registering %b', JSON.stringify(req.body));

        options.register(req.body)
        .then(function(user) {
            sendAuthorizationResponse(res, user);
        })
        .catch(function(err) {
          //  Bad Request :The server cannot or will not process the request due to an apparent client error (e.g., malformed request syntax, invalid request message framing, or deceptive request routing).
            res.status(400).send({code: err});
        });
    }

    function sendAuthorizationResponse(res, user, type) {
        const token = options.authorization(options.claim(user));
        let url;

        if (type === 'rest') {
            url = options.restUrl ? options.restUrl(token, user) : null;
        } else {
            url = options.appUrl ? options.appUrl(token, user) : null;
        }

        res.json({
            issued_at: Date.now(),
            access_token: token,
            url: url
        });
    }

    function generateDefaultAuthorizationCode(payload) {
        return jwt.sign(payload, options.secret, {
            expiresIn: options.codeExpiresInSecs
        });
    }
};
