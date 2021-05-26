
const jwt = require('jsonwebtoken');
const blackListService = require('../token-blacklist.service');

const UnauthorizedError = require('./UnauthorizedError');

async function verifyJwtToken(token, options) {
    if (!options.secret) {
        throw new UnauthorizedError('invalid_secret', {message: 'Secret is not provided'});
    }
    let decodedToken;
    try {
        decodedToken = jwt.verify(token, options.secret, options);
    } catch (err) {
        throw new UnauthorizedError('invalid_token', {message: 'Token is invalid'});
    }
    // Revoked token cannot be re-used.
    if (await blackListService.isTokenRevoked(token)) {
        throw new UnauthorizedError('revoked_token', {message: 'Token was revoked'});
    }
    return decodedToken;
}

module.exports = {
    verifyJwtToken
};
