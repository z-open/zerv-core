'use strict';
const Promise = require('promise');
const _ = require('lodash');
const zlog = require('zlog4js');

const logger = zlog.getLogger('abstract-transaction');


let transactionId = 1;

class Transaction {
    constructor(parentTransaction, implementation, options) {
        if (arguments.length !== 3 || !_.isObject(options))
            throw new Error('Missing constructor parameters in your transaction implementation');
        const thisTransaction = this;
        this.innerTransactions = [];
        this.innerCommitStack = [];
        this.status = 'running';
        this.options = options;


        if (parentTransaction) {
            constructInnerTransaction(
                thisTransaction,
                parentTransaction,
                options.name,
                implementation.processInnerBegin,
                implementation.processInnerCommit,
                implementation.processInnerRollback);
        } else {
            constructMainTransaction(
                thisTransaction,
                parentTransaction,
                options.name,
                implementation.processBegin,
                implementation.processCommit,
                implementation.processRollback);
        }
    }


    execute(processFn) {
        const thisTransaction = this;
        const impl = this.impl;
        let processResult;

        return processBegin()
            .then(processExecution)
            .then(processCommit)
            .then(() => processResult)
            .catch(processRollback);


        function processBegin() {
            logger.info('%s - Begin.', thisTransaction.display);
            let result;
            try {
                result = impl.processBegin();
            } catch (err) {
                // programmer error
                return Promise.reject(err);
            }
            return Promise.resolve(result);
        }


        function processExecution() {
            const result = processFn(thisTransaction);
            if (!_.isObject(result) || !_.isFunction(result.then))
                return Promise.reject('TRANSACTION_EXECUTION_NOT_RETURNING_A_PROMISE');
            processResult = result;
            return result;
        }


        function processCommit() {
            // if inner transaction has not committed
            // it means a transaction was started parrallely, and the code is not waiting for its completion
            // unfortunately, if the inner transaction finished before the main commits, it will not be detected
            if (_.some(thisTransaction.innerTransactions, (trans) => trans.status === 'running')) {
                logger.error('%s - Transaction is committing before an inner transaction completed.', thisTransaction.display);
                throw new Error('INNER_TRANSACTION_NOT_AWAITED');
            }

            if (thisTransaction.parentTransaction && thisTransaction.parentTransaction.status !== 'running') {
                logger.error('%s - Inner Transaction is committing after its parent transaction.', thisTransaction.display);
                throw new Error('INNER_TRANSACTION_NOT_AWAITED');
            }

            if (_.some(thisTransaction.innerTransactions, (trans) => trans.status === 'rolledback')) {
                throw new Error('INNER_TRANSACTION_ROLLED_BACK');
            }

            logger.info('%s - Commit.', thisTransaction.display);
            const result = Promise.resolve(impl.processCommit(thisTransaction))
                .then((_result) => {
                    onCommit(_result);
                    return _result;
                });

            thisTransaction.status = 'committed';

            if (thisTransaction.parentTransaction)
                _.remove(thisTransaction.parentTransaction.innerTransactions, thisTransaction);

            return result;

            function onCommit(result) {
                if (!thisTransaction.options.onCommit) return;

                 // the onCommit shall be exectured only when the main transaction commit !!!!!!
                 if (thisTransaction.parentTransaction) {
                    Array.prototype.push.apply(thisTransaction.parentTransaction.innerCommitStack, thisTransaction.innerCommitStack);
                    thisTransaction.parentTransaction.innerCommitStack.push(() => callback(result));
                } else {
                    _.forEach(thisTransaction.innerCommitStack, (fn) => fn());
                    callback(result);
                }

                function callback(result) {
                    try {
                        logger.info('%s - on commit.', thisTransaction.display);
                        Promise.resolve(thisTransaction.options.onCommit(result))
                        .catch((err) => {
                            logger.error('%s - irrecoverable failure as on Commit failed', thisTransaction.display, err);
                        });
                    } catch (err) {
                        logger.error('%s - irrecoverable failure as on Commit failed', thisTransaction.display, err);
                    }
                }
            }
        }


        function processRollback(err) {
            logger.warn('%s - Roll back.', thisTransaction.display, err);
            Promise.resolve(impl.processRollback(err))
                .then(() => onRollback());
            thisTransaction.rollback(err);
            return;


            function onRollback() {
                if (!thisTransaction.options.onRollback) return;
                logger.info('%s - on rollback.', thisTransaction.display);
                try {
                    Promise.resolve(thisTransaction.options.onRollback())
                    .catch((err) => {
                        logger.error('%s - irrecoverable failure as on rollback failed', thisTransaction.display, err);
                    });
                } catch (err) {
                    logger.error('%s - irrecoverable failure as on rollback failed', thisTransaction.display, err);
                }
            }
        }
    }

    rollback(err) {
        this.status = 'rolledback';
        throw err || new Error('ROLL_BACK');
    }
}

function constructInnerTransaction(thisTransaction, parentTransaction, name, processBegin, processCommit, processRollback) {
    thisTransaction.parentTransaction = parentTransaction;
    thisTransaction.level = parentTransaction.level + 1;
    thisTransaction.impl = {
        processBegin,
        processCommit,
        processRollback,
        parentTransaction
    };
    parentTransaction.innerTransactions.push(thisTransaction);
    thisTransaction.name = parentTransaction.name + '/' + (name || ('Level ' + thisTransaction.level));
    thisTransaction.display = formatName(thisTransaction.name);
}

function constructMainTransaction(thisTransaction, parentTransaction, name, processBegin, processCommit, processRollback) {
    thisTransaction.level = 0;
    thisTransaction.impl = {
        processBegin,
        processCommit,
        processRollback,
        parentTransaction
    };
    thisTransaction.name = (name || 'id') + ' #' + transactionId++;
    thisTransaction.display = formatName(thisTransaction.name);
}


function formatName(composed) {
    return 'System Trans ['+ composed +']';
}


class DefaultTransactionImplementation extends Transaction {
    constructor(parentTransaction, options) {
        super(
            parentTransaction, {
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
 * @param {*} requirement can be REUSE or NEW or REUSE_OR_NEW
 * @param {*} parentTransaction
 * @param {*} options // this is passed to the transaction implementation
 *      - implementationClass is the transaction class to instantiate
 *      - onCommit is the callback called after commit
 *      - onRollback is the callback called after rollback
 */
function defineTransaction(requirement, parentTransaction, options) {
    // Typical use of requirements
    switch (requirement) {
        case 'REUSE':
            if (!parentTransaction || !(parentTransaction instanceof Transaction)) throw new Error('PARENT_TRANSACTION_NOT_PROVIDED');
            break;
        case 'NEW':
            if (parentTransaction instanceof Transaction) throw new Error('PARENT_TRANSACTION_MAY_NOT_BE_PROVIDED');
            if (arguments.length === 2) {
                options = parentTransaction;
            }
            parentTransaction = null;
            break;
        case 'REUSE_OR_NEW':
            if (parentTransaction && !(parentTransaction instanceof Transaction))
                parentTransaction = null;
            break;
        default:
            throw new Error('TRANSACTION_REQUIREMENT_UNKNOWN');
    }

    options = _.assign({}, options);

    const Impl = options.implementationClass || DefaultTransactionImplementation;
    return new Impl(parentTransaction, options);
}


module.exports = {
    defineTransaction,
    TransactionCoreClass: Transaction,
    TransactionImplementationClass: DefaultTransactionImplementation
};


