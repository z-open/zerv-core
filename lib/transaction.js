'use strict';
const _ = require('lodash');
const zlog = require('zlog4js');

const abstractTransaction = require('abstract-transaction');

const logger = zlog.getLogger('zerv/transaction');

/**
 * start a transaction
 *
 * @param {*} zerv
 * @param {*} requirement can be REUSE or NEW or REUSE_OR_NEW
 * @param {*} parentTransactionHandler
 * @param {Object} options, this is passed to the transaction implementation
 *      - {function} onCommit: to set the function to call on commit
 *      - {function} onRollbacl: to set the function to call on roll back
 *      - {String} name: To modify the default name for this transaction
 *      - {AbstractZervTransaction} implementationClass: To set the transaction implementation class that will be instantiated instead of the default one.
 */
function defineTransaction(zerv, requirement, parentTransactionHandler, options) {
    if (!parentTransactionHandler || parentTransactionHandler.constructor.name !== 'TransactionHandler') {
        options = parentTransactionHandler;
        parentTransactionHandler = null;
    }

    const zervOptions = _.assign({
        zerv,
        DefaultImplementationClass: zerv.TransactionImplementationClass || DefaultZervTransaction
    }, options);

    if (zervOptions.implementationClass instanceof AbstractZervTransaction) throw new Error('Transaction implementation must inherit ZervTransaction.');

    if (!zervOptions.DefaultImplementationClass && !zervOptions.implementationClass) throw new Error('Transaction implementation has not be provided.');

    return abstractTransaction.defineTransaction(requirement, parentTransactionHandler, zervOptions);
}


function notify(thisTransaction) {
    if (thisTransaction.parentTransaction) {
        notifyParentTransaction(thisTransaction);
    } else {
        notifyZervSync(thisTransaction);
    }
}


function notifyZervSync(thisTransaction) {
    _.forEach(thisTransaction.notifications, notification => {
        switch (notification.type) {
            case 'creation':
                thisTransaction.zerv.notifyCreation(notification.tenantId, notification.name, notification.objects);
                break;
            case 'update':
                thisTransaction.zerv.notifyUpdate(notification.tenantId, notification.name, notification.objects);
                break;
            case 'delete':
                thisTransaction.zerv.notifyDelete(notification.tenantId, notification.name, notification.objects);
                break;
        };
    });
}


function notifyParentTransaction(thisTransaction) {
    logger.info('%s - buffer %d event(s)', thisTransaction.display, thisTransaction.notifications.length);
    _.forEach(thisTransaction.notifications,
        (notif) => thisTransaction.parentTransaction.notifications.push(notif));
}


function addNotifications(thisTransaction, ...params) {
    let tenantId, name, type, objects;
    if (params.length === 3) {
        tenantId = thisTransaction.tenantId;
        name = params[0];
        type = params[1];
        objects = params[2];
    } else if (params.length === 4) {
        tenantId = params[0];
        name = params[1];
        type = params[2];
        objects = params[3];
    } else throw new Error('Incorrect number of arguments');

    thisTransaction.notifications.push({
        tenantId,
        name,
        type,
        objects
    });
}


function formatName(user, composed) {
    if (user) {
        return user.display + ': Trans [' + composed + ']';
    }
    return 'System Trans [' + composed + ']';
}


/*
* This class must be extended and cannot be instantiated directly
*/
class AbstractZervTransaction extends abstractTransaction.getCoreTransactionClass() {
    constructor(parentTransaction, transactionImpl, options) {
        const newOptions = _.assign(
            {},
            options,
            {onCommit: onCommitWhichAlsoNotifies}
        );
        super(parentTransaction, transactionImpl, newOptions);
         // make sure that zerv is available to any inner transaction
        this.zerv = parentTransaction ? parentTransaction.zerv : newOptions.zerv;
        this.tenantId = newOptions.tenantId;
        this.notifications = [];
        this.display = formatName(this.user, this.name);

        function onCommitWhichAlsoNotifies(result, thisTransaction) {
            notify(thisTransaction);
            if (options && options.onCommit) return options.onCommit.apply(thisTransaction, arguments);
        }
    }

    /**
     * Notify a record creation to be published to subscribers
     *
     * @param {String} tenantId which is optional is the transaction was provided the tenantId
     * @param {*} dataNotificationName
     * @param {*} notifiedObjects
     */
    notifyCreation(tenantId, dataNotificationName, notifiedObjects) {
        addNotifications(this, tenantId, dataNotificationName, 'creation', notifiedObjects);
    }

    notifyDelete(tenantId, dataNotificationName, notifiedObjects) {
        addNotifications(this, tenantId, dataNotificationName, 'delete', notifiedObjects);
    }

    notifyUpdate(tenantId, dataNotificationName, notifiedObjects) {
        addNotifications(this, tenantId, dataNotificationName, 'update', notifiedObjects);
    }
}


/**
 * This Class is just a mock and does not implement any technology to commit or rollback.
 * It is useful for testing.
 */
class DefaultZervTransaction extends AbstractZervTransaction {
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
}

// Initialize this instance of zerv with the transaction feature.
function init(zerv) {
    _.assign(zerv,
        {
            defineTransaction: setTransaction,
            startTransaction,
            reUseOrCreateTransaction,
            getCoreTransactionClass,
            setTransactionImplementationClass
        });
    function setTransaction() {
        return defineTransaction.apply(this, _.concat([], zerv, arguments));
    }

    function startTransaction(options) {
        return defineTransaction(zerv, 'NEW', options);
    }

    function reUseOrCreateTransaction(parentTransaction, options) {
        return defineTransaction(zerv, 'REUSE_OR_NEW', parentTransaction, options);
    }

    function getCoreTransactionClass() {
        return AbstractZervTransaction;
    }

    function setTransactionImplementationClass(implClass) {
        zerv.TransactionImplementationClass = implClass;
    }
}


module.exports = {init};
