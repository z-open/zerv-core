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
 * @param {*} parentTransaction
 * @param {*} options // this is passed to the transaction implementation
 */
function defineTransaction(zerv, requirement, parentTransaction, options) {
    if (!parentTransaction instanceof abstractTransaction.getCoreTransactionClass()) {
        options = parentTransaction;
        parentTransaction = null;
    }
    const zervOptions = _.assign({}, options);

    if (zerv.TransactionImplementationClass) {
        zervOptions.implementationClass = zerv.TransactionImplementationClass;
    }

    let transaction;

    zervOptions.onCommit = (result) => {
        if (parentTransaction) {
            notifyParentTransaction(transaction);
        } else {
            notifyZervSync(zerv, transaction);
        }
        if (options && options.onCommit)
        return options.onCommit.apply(this, arguments);
    };

    transaction = abstractTransaction.defineTransaction(requirement, parentTransaction, zervOptions);

    transaction.notifications = [];
    transaction.notifyCreation = notifyCreation;
    transaction.notifyUpdate = notifyUpdate,
    transaction.notifyDelete = notifyDelete;
    transaction.display = formatName(transaction.user, transaction.name);

    return transaction;


    function notifyCreation(tenantId, dataNotificationName, notifiedObjects) {
        addNotifications(this, tenantId, dataNotificationName, 'creation', notifiedObjects);
    }

    function notifyDelete(tenantId, dataNotificationName, notifiedObjects) {
        addNotifications(this, tenantId, dataNotificationName, 'delete', notifiedObjects);
    }

    function notifyUpdate(tenantId, dataNotificationName, notifiedObjects) {
        addNotifications(this, tenantId, dataNotificationName, 'update', notifiedObjects);
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

module.exports = {
    defineTransaction,
    startTransaction: abstractTransaction.startTransaction,
    reUseOrCreateTransaction: abstractTransaction.reUseOrCreateTransaction,
    TransactionCoreClass: abstractTransaction.getCoreTransactionClass(),
    TransactionImplementationClass: abstractTransaction.TransactionImplementationClass
};


