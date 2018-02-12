'use strict';
const _ = require('lodash');
const zlog = require('zlog4js');

const abstractTransaction = require('abstract-transaction');

const logger = zlog.getLogger('zerv/transaction');

/**
 * return transaction('REUSE_OR_NEW',parentTransaction,{
 *      name: 'Important transaction'
 *      enablePartialCommit: true // not implemented
 *      onMainCommit: () => { // not implemented
 *          console.info('This is executed after main transaction has committed)
 *      }
 * })
 *        .execute(() => service.update.bind(transaction)(args))
 *        .then(() => console.info('it is committed'))
 *        .catch(() => console.info('it is rolled back'))

 * @param {*} zerv
 * @param {*} requirement can be REUSE or NEW or REUSE_OR_NEW
 * @param {*} parentTransactionHandler
 * @param {*} options // this is passed to the transaction implementation
 */
function defineTransaction(zerv, requirement, parentTransactionHandler, options) {
    if (!parentTransactionHandler || parentTransactionHandler.constructor.name !== 'TransactionHandler') {
        options = parentTransactionHandler;
        parentTransactionHandler = null;
    }

    const zervOptions = _.assign({zerv}, options);
    if (!zervOptions.implementationClass && zerv.TransactionImplementationClass) {
        zervOptions.implementationClass = zerv.TransactionImplementationClass;
    }

    if (zervOptions.implementationClass instanceof ZervTransaction) throw new Error('Transaction implementation must inherit ZervTransaction.');

    zervOptions.onCommit = function(result, thisTransaction) {
        notify(thisTransaction, zerv);
        if (options && options.onCommit) return options.onCommit.apply(thisTransaction, arguments);
    };
    return abstractTransaction.defineTransaction(requirement, parentTransactionHandler, zervOptions);
}


function notify(thisTransaction, zerv) {
    if (thisTransaction.parentTransaction) {
        notifyParentTransaction(thisTransaction);
    } else {
        notifyZervSync(zerv, thisTransaction);
    }
}


function notifyZervSync(zerv, thisTransaction) {
    _.forEach(thisTransaction.notifications, notification => {
        switch (notification.type) {
            case 'creation':
                zerv.notifyCreation(notification.tenantId, notification.name, notification.objects);
                break;
            case 'update':
                zerv.notifyUpdate(notification.tenantId, notification.name, notification.objects);
                break;
            case 'delete':
                zerv.notifyDelete(notification.tenantId, notification.name, notification.objects);
                break;
        };
    });
}


function notifyParentTransaction(thisTransaction) {
    logger.info('%s - buffer %d event(s)', thisTransaction.display, thisTransaction.notifications.length);
    _.forEach(thisTransaction.notifications,
        (notif) => thisTransaction.parentTransaction.notifications.push(notif));
}


function addNotifications(thisTransaction, tenantId, name, type, objects) {
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

class ZervTransaction extends abstractTransaction.getCoreTransactionClass() {
    constructor(parentTransaction, transactionImpl, options) {
        super(parentTransaction, transactionImpl, options);
        this.notifications = [];
        this.display = formatName(this.user, this.name);
    }

    // overriding is wrong, since we might override the custom startInner
    // the start inner of abstract transaction should call the constructor of the default transaction (should be passed as options) or used the innerOptions class.
    // the constructor would do what is in defineTransaction
    startInner(innerOptions) {
        return defineTransaction(this.options.zerv, 'REUSE', this.handler, _.assign({zerv: this.options.zerv}, innerOptions));
    }

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

    function reUseOrCreateTransaction() {
        return defineTransaction(zerv, 'REUSE_OR_NEW', parentTransaction, options);
    }

    function getCoreTransactionClass() {
        return ZervTransaction;
    }

    function setTransactionImplementationClass(implClass) {
        zerv.TransactionImplementationClass = implClass;
    }
}


module.exports = {init};
