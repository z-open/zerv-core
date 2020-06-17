
Authenticate socket.io incoming connections with authorization code followed by token, the latter will be blacklisted and refreshed for a safer connection.

This implementation was inspired on the following articles:

https://developer.salesforce.com/page/File:OAuthWebServerFlow.png

https://stormpath.com/blog/jwt-the-right-way/

https://developer.salesforce.com/page/Digging_Deeper_into_OAuth_2.0_on_Force.com

## Description

This npm package provides the middleware to secure your express/socketio application. the following components are available for use on the same server or different ones: 
- login/registration api 
- Secure websockets / secure api router 


## Use Case

__Main flow__

This will handle the following flow:

- Client Sends user credentials or registration with a post to a server api (/login or /register).
- System returns a short life token or url with token (options.appUrl)
- Client connects sockets
- Then it emits "authenticate" and passed the just received token
(If system receives token too late (timeout), it will emit unauthorized)
- System verifies the token and emits "authenticated" back to the client with a new token (with a long life span)
- On receiving "authenticated", client stores the just received token for future reconnection use.

__Alternate flows__

If the connection is lost, client will reconnect with the stored token and receive a refreshed one.

If A token previous used and replaced by a new one is received by the server, it will send unauthorized.

If a token is about to expire, the client should request a new one before too late.

If client socket emits "logout" with its current token, server will invalidate token to prevent reuse and send back "logged_out".
Client can then delete its token / redirect to logout or login page.

## Installation
```
npm install "git://github.com/z-open/socketio-auth#version
```

## Usage

__socketIoAuth.socketServe(server, options)__

This creates an instance of socketio that handles connection/reconnection via tokens. 

Options are the following:

- refresh: to provide a function that returns a token, based on a payload. There is a function by default that returns a JWT sign token.

- claim: to provide a function that returns a claim based on a user

- secret: the value to compute the jwt token if the default generation is used;

- disposalInterval: value in minutes, interval between attempt to dispose revoked token from the black list (get rid of expired token since they can not be reused anyway) 

- tokenExpiresInMins: duration of the session token (long life).

- maxInactiveTimeInMinsForInactiveSession: duration before an inactive local   user session is destroyed (and all associated resources released) on the server. A browser might lose its socket connections which would lead the local user session to be inactive in the server. 
A browser might disconnect temporarily due to network instability, browser being put in the background, OS standby, etc...
If the browser reconnects quickly, the session is set back to active without the need to reload resources or cache. By default, the value is 10 minutes.

- getTenantId: to provide a function which receives the payload as a parameter. This function shall return a promise that returns the tenantId. When a token is created, the tenant id will be obtained via this function and stored in the socket instance. 


__socketioAuth.apiServe(app,options)__

This will add login and register request handling to an express app.
If credentials are posted to url /login or /registration, a authorization code or app url will be sent back. The client will need it to connect the socketio instance.

Options are the following:

- claim: to provide a function that returns a claim based on a user

- secret: the value to compute the jwt token if the default generation is used;

- findUserByCredentials : to provide a function that returns a promise with the user...ex: find user in a db matching email and password

- appUrl: if this function is provided, it will receive the auth code as a parameter. It should return the proper url to contact the socketio instance and pass the auth code as a querystring. By default, client will receive the auth code if the appUrl is not provided.

- authorization: to provide a function that returns a auth code, based on a payload. There is a function by default that simply sets its expiration.

- codeExpiresInSecs: duration of the auth code (short life) if the refresh option is not provided.


__socketIoAuth.apiRouter(socketIoInstance,'myApi')__

create an instance of the api router. then you just have to register via the on service method your api execution code for each call. The api router makes sure you have an authenticated user before executing any api call.

Ex:
```javascript
apiRouter.on('list',function handle(params) {
    var handler = this;
    console.log('Call from User '+handler.userId+'- TenantId:'+handler.tenantId+' -'+ JSON.stringify(handler.user));
    return promiseThatReturnsData(...params...);
});
```
the handle function has access to a handler. The handler object has the following properties and methods:
- userId
- user (which is the payload)
- tenantId (if the getTenantId() was provided as a socketServe option)
- broadcast (send a socket event to all users except the one being handled)
- broadcastAll (send a socket event to all users as well as the one being handled)

the client would use the following:
```javascript
socket.emit('myApi','list',someParams,callbackToDoSomethingWithReceivedData);
```

__socketioAuth.infraServe(server,app,options)__

will create the secure web socket server and configure the api to run on the same server. This returns an instance of api router. 

In addition to all options listed above, we have the following:

- api : the event name used from a socket to make the api calls handled by the apiRouter. By default, 'api'.


## User Session Management

__api functions__

- zerv.isLocalUserSession(userSession)

This returns true if the provided userSession exists on the current server.

- zerv.countLocalSessionsByUserId(userId)

This returns the number of active user sessions for the provided user id on the current server.

- zerv.isUserSessionServerOrigin(userSession)

This returns true if the userSession was created on this server.
The session might not longer exist.

- zerv.getLocalUserSessions

This returns all local user sessions either active (with socket connections) or inactivate (without any socket connections)

- zerv.onLocalUserSessionDestroy(callback, reason)

Add a listener (callback function) and returns the a function to remove the listener.
The listener will be provided the local user session that was destroyed and the reason.
A local user session is destroyed after being inactive for some time in order to release resources (such as zerv subscriptions and cache). 

- zerv.setTenantMaximumActiveSessionTimeout(tenantId, valueInMinute)

This sets the expiration timeout for an active session before the session is automatically logged out from all participating servers.

- zerv.getTenantMaximumActiveSessionTimeoutInMins(tenantId)

This returns the tenant's expiration timeout value for an active session.
By default, the value is 720 minutes or the value provided in the environment variable ZERV_MAX_ACTIVE_SESSION_TIMEOUT_IN_MINS.

__Server side__

A USER_SESSION event is notified to the cluster after a user succesfully connects (browser refresh, or login) or disconnects any zerv instance.

```javascript
// the server can get notified for any new user session update from any server
zerv.onChanges('USER_SESSION', (tenantId, userSession, notificationType) => {
        console.log('Session ', userSession.payload, notificationType, userSession.zervServerId);
    });

zerv.onLocalUserSessionDestroy((localUserSession, reason) => {
    letSreleaseUserResources(localUserSession.tenantId, localUserSession.userId);
});
```
__Subscribing a client to user session data__

In the zerv-sync module, you can read how to exploit any event on the front end. To sum up:
A publication could also be created to receive user session changes via this event. 
A subscription would be able to receive the changes on the front end.

## shutdown support

__shutdown(delay)__
The function will exit the node process when all current api calls completed and will not accept any further call to any zerv api.

```javascript
zerv.shutdown(10);
```
__isServerShutDownInProgress()__

this function returns true is the zerv server is in the process of shutting down.


## Transaction support

__transaction Api__

To implementation transaction support to an api process, get the transaction instance.

Ex:
```javascript

apiRouter.on('accountTransfer',function handle(params) {
    var handler = this;
    return  handler.getTransaction()      .execute((transaction) => 
        Promise.all([
            debit(transaction, params.source, params.amount),
            credit(params.dest, params.amount)
        ])
    );
});

function debit(transaction, tenantid, account, amount) {
    const bankTrans = new BankTransaction(account, amount);
    return transaction.executeQuery('insert in table ...',bankTrans)
    .then(() => transaction.notifyCreation(tenantId, 'BANK_TRANS', bankTrans));
}

```

Here the debit function uses the transaction to execute a sql statement.

The transaction also provides the notification functions necessary for zerv-sync (see library).
It is only if the whole transaction commits successfully that notifications will be issued.

THe transaction implementation must set in  zerv configuration at server start.


```javascript
class DbTransactionImplementation extends zerv.TransactionCoreClass {

    // the constructor structure
    constructor(parentTransaction, options) {
        super(parentTransaction, {
            processBegin: _.noop,
            processCommit: _.noop,
            processRollback: _.noop,
            processInnerBegin: _.noop,
            processInnerCommit: _.noop,
            processInnerRollback: _.noop
        },
        options);
    }

    // User define functions
    executeQuery(statement) {
        return Promise.resolve('SUCCESS');
    }
}

zerv.TransactionImplementationClass = DbTransactionImplementation;
```
The implementation must provide the transactional functions your intend to user, ex: executeQuery in the example above.

The transaction class must also implement the commit and rollback. 
In the case of a db, the processBegin might provide the begin statement you need to issue to a db.
The processCommit and processRollback would provide the commit and rollback statements.

All functions must return a promise.

Ssupport for transaction recovery point for inner transaction can also be implemented.

__Other transactional process__

Transactional process independent from the api route transaction might also be implemented

```javascript
function independentProcess() {
    return zerv.defineTransaction('NEW')
    execute((transaction) => service.do(transaction, other params))
}

function independentProcessThatMightReuseAnExistingTransaction(parentTransaction) {
    return zerv.defineTransaction('REUSE_OR_NEW', parentTransaction)
    execute((transaction) => service.do(transaction, other params))
}
```

zerv.defineTransaction(requirements, parentTransaction, options)

Requirements : USE, NEW, REUSE_OR_NEW

Options: 
onCommit callback is executed after the transaction commits.
onRollback callback is executed after the transaction rollbacks.


## Challenges to address

__Auth Code and token access__

* After calling the login api, a auth code is passed back to the client via https. Then client will redirect to app url exposing the auth code. It will expire in seconds but still could be stolen.
 
* Tokens are communicated via the websocket over https. However, token might be stored on the client to allow reconnection in case of refresh. If someone could extract the token from the client (would need access the machine or shell), it can be used to make a new connection on a new client which would prevent the original owner to reconnect.

Solution could be to find a way to confirm that the new connection is issued from the same machine... (Ip might not be the best solution, as they are dynamically provided, and public ip is shared by multiple clients on a network. Drastic change of ip could be detected (different location))


__Scalling Right__:

https://nodejs.org/api/cluster.html
"There is no routing logic in Node.js, or in your program, and no shared state between the workers. Therefore, it is important to design your program such that it does not rely too heavily on in-memory data objects for things like sessions and login."

http://goldfirestudios.com/blog/136/Horizontally-Scaling-Node.js-and-WebSockets-with-Redis

## Contribute

You are always welcome to open an issue or provide a pull-request!

Also check out the unit tests:
```bash
npm install
npm test
```

## Issue Reporting


If you have found a bug or if you have a feature request, please report them at this repository issues section. Please do not report security vulnerabilities on the public GitHub issue tracker. 

## Author

[z-open]

## License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file for more info.
