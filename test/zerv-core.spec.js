const _ = require('lodash');
const express = require('express');
const http = require('http');
const zerv = require('../lib/zerv-core');

describe('zerv-core', () => {
    let server, options;
    beforeEach(() => {
        const app = express();
        server = http.createServer(app);

        options = {
            claim: _.noop,
            findUserByCredentials: _.noop
        };
    });

    describe('socketServe', () => {

        it('should use maxHttpBufferSize default value', () => {
            const io = zerv.socketServe(server, options);
            expect(io.opts).toEqual({
                maxHttpBufferSize: 102400000
            });
        });

        it('should set the maxHttpBufferSize value', () => {
            options.maxHttpBufferSize = 2048;
            const io = zerv.socketServe(server, options);
            expect(io.opts).toEqual({
                maxHttpBufferSize: 2048
            });
        });
    });
});
