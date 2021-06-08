const zlog = require('zimit-zlog');
const {verifyJwtToken} = require('./authorize.helper');
const logger = zlog.getLogger('zerv/core/http-authorize');

/**
 * Check Authorization of a http request.
 *
 * Reuse the socket authorize implementation for now.
 *
 * @param {Object} options (check jsonwebtoken verify function for other options)
 * @param {string} options.secret  the secret value to compute the jwt (mandatory)
 * 
 * @param {Object} req usually represents the HTTP request provided by the express framework
 *                     The following properties are exploited and mandatory:
 * @param {Map<string>} req.headers which should contain a string value for access-token key
 * @param {string} req.url which contains the request url value
 * 
 * @returns {Promise<Object, string} which resolves with the following object on success
 *    { payload,newToken}
 */
async function httpAuthorize(options, req) {
    try {
        const token = req.headers['access-token'];
        const decodedToken = await verifyJwtToken(token, options);
        return {
            payload: decodedToken,
            newToken: 'not implemented'
        };
    } catch (error) {
        logger.info('Unauthorized access %b to %b', error.message, req.url);
        throw error;
    }
}

module.exports = httpAuthorize;
