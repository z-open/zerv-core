const zlog = require('zimit-zlog');
const {verifyJwtToken} = require('./authorize.helper');
const logger = zlog.getLogger('zerv/core/http-authorize');

/**
 * Check Authorization of a http request.
 *
 * Reuse the socket authorize implementation for now.
 *
 * @param {*} options
 * @param {*} req
 * @param {*} res
 *
 * @returns {Promise} which resolves with the following object on success
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
