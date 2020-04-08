'use strict';
const ApiRouter = require('../lib/api-router');
const serverActivityService = require('../lib/server-activity.service');

describe('ApiRouter', () => {
    let io;
    let socket;
    let transport;
    let apiRouter;
    let apiDoSomethingImpl;

    beforeEach(() => {
        let socketOnCallback;
        socket = {
            id: 'socketId',
            userId: 'user23',
            origin: 'browserId3',
            tenantId: 'corpPlus',
            payload: '12345678',
            creation: '02/01/2020',
            on: async function(event, fn) {
                socketOnCallback = arguments[1];
            },
            emit: (name, data) => new Promise((resolve) => {
                socketOnCallback(name, data, resolve);
            })
        };

        function mockOnEvent(onEvent) {
            // during test, the same socket is used
            onEvent(socket);
        }

        io = {
            on: (e, onEvent) => mockOnEvent(onEvent),
        };

        transport = {
            deserialize: (data) => data,
            serialize: (data) => data
        };

        apiDoSomethingImpl = (data) => 'Hello '+ data.name;
    });

    it('should execute api', async () => {
        apiRouter = new ApiRouter(io, 'API', transport, null);
        apiRouter.on('apiDoSomething', apiDoSomethingImpl, null);
        spyOn(serverActivityService, 'registerNewActivity').and.callThrough();

        const response = await socket.emit('apiDoSomething', {name: 'John'});
        expect(serverActivityService.registerNewActivity).toHaveBeenCalledWith(
            'apiDoSomething',
            {tenantId: 'corpPlus'},
            {origin: 'zerv api'}
        );
        expect(serverActivityService.getActivitiesInProcess().length).toEqual(0);
        expect(response).toEqual({
            code: 0,
            data: 'Hello John'
        });
    });

    it('should register and close activity when executing api call', (done) => {
        apiRouter = new ApiRouter(io, 'API', transport, null);
        let completeSomething;
        const doSomething = (data) => new Promise(resolve => {
            completeSomething = () => resolve('Hello '+ data.name);
        });

        apiRouter.on('apiDoSomething', doSomething, null);

        spyOn(serverActivityService, 'registerNewActivity').and.callThrough();

        socket.emit('apiDoSomething', {name: 'John'})
        .then((response) => {
            expect(response).toEqual({
                code: 0,
                data: 'Hello John'
            });
            expect(serverActivityService.getActivitiesInProcess().length).toEqual(0);
            done();
        });

        expect(serverActivityService.registerNewActivity).toHaveBeenCalledWith(
            'apiDoSomething',
            {tenantId: 'corpPlus'},
            {origin: 'zerv api'}
        );
        expect(serverActivityService.getActivitiesInProcess().length).toEqual(1);

        completeSomething();
    });


    it('should not execute unknown api', async () => {
        apiRouter = new ApiRouter(io, 'API', transport, null);
        apiRouter.on('apiDoSomething', apiDoSomethingImpl, null);

        const response = await socket.emit('unknownApi', {name: 'John'});
        expect(response).toEqual({
            code: 'API-UNKNOWN',
            data: 'Unknown API call [unknownApi]'
        });
    });
});
