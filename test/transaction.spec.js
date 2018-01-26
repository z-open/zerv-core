'use strict';
const Promise = require('promise');
const _ = require('lodash');
const zerv = require('../lib/zerv-core');

let defineTransaction;

describe('transaction', () => {
    const tenantId = 'tenantId1';
    const successfullProcess = () => Promise.resolve();
    const failedProcess = () => Promise.reject('A PROCESS ERROR');

    const successfullProcessWithNotifications = (transaction) => {
        transaction.notifyCreation(tenantId, 'MAGAZINE', {id: 1, description: 'super magazine'});
        return Promise.resolve();
    };
    const failedProcessWithNotifications = () => Promise.reject('A PROCESS ERROR');

    beforeEach(() => {
        defineTransaction = zerv.defineTransaction;

        class TransactionImplementation extends zerv.TransactionCoreClass {
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

        zerv.notifyCreation = _.noop;
        zerv.defineTransaction.implementationClass = TransactionImplementation;

        spyOn(zerv, 'notifyCreation');
    });

    it('should commit', (done) => {
        defineTransaction('NEW')
        .execute(successfullProcess)
        .then(done)
        .catch((err) => done.fail(err));
    });

    it('should commit and notify', (done) => {
        defineTransaction('NEW')
        .execute(successfullProcessWithNotifications)
        .then(() => {
            expect(zerv.notifyCreation).toHaveBeenCalled();
            done();
        })
        .catch((err) => done.fail(err));
    });

    it('should rollback', (done) => {
        defineTransaction('NEW')
        .execute(failedProcess)
        .then(() => done.fail('should have rolled back'))
        .catch(done);
    });

    it('should rollback and never notify', (done) => {
        defineTransaction('NEW')
        .execute(failedProcess)
        .then(() => done.fail('should have rolled back'))
        .catch(() => {
            expect(zerv.notifyCreation).not.toHaveBeenCalled();
            // expect(zerv.notifyCreation.calls.count()).toEquals(0);
            done();
        });
    });

    it('should commit all transactions', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            return defineTransaction('REUSE', transaction)
                .execute(successfullProcess);
        })
        .then(done)
        .catch((err) => done.fail(err));
    });

    it('should rollback due to inner transaction rollback', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            return defineTransaction('REUSE', transaction)
                .execute(failedProcess);
        })
        .then(() => done.fail('should have rolled back'))
        .catch(done);
    });

    it('should rollback due to inner transaction rollback even if the inner transaction promise does not reject', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            return defineTransaction('REUSE', transaction)
                .execute(failedProcessWithNotifications)
                .catch((err) => {
                    return err; // promise does not reject anymore
                });
        })
        .then(() => done.fail('should have rolled back'))
        .catch(() => {
            expect(zerv.notifyCreation).not.toHaveBeenCalled();
            // expect(zerv.notifyCreation.calls.count()).toEquals(0);
            done();
        });
    });

    it('should fail due to a transaction process not returning a promise', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            // there is no return
            defineTransaction('REUSE', transaction)
                .execute(failedProcessWithNotifications);
        })
        .then(() => done.fail('should have rolled back'))
        .catch((err) => {
            expect(err).toEqual('TRANSACTION_EXECUTION_NOT_RETURNING_A_PROMISE');
            // expect(zerv.notifyCreation.calls.count()).toEquals(0);
            done();
        });
    });

    it('should commit all transactions but display an error due inner transaction not awaited', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            // there is no return
            setTimeout(() =>
            defineTransaction('REUSE', transaction)
                .execute(successfullProcess),
                1000);
            return Promise.resolve();
        })
        .then(() => done())
        .catch(() => {
            done.fail('Should have been able to commit both transaction, but there is an error on the console');
        });
    });

    it('should not commit the main transaction due to inner transaction has not completed and was not awaited', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            // there is no return
            defineTransaction('REUSE', transaction)
                .execute(setTimeout(() => successfullProcess(),
                1000));
            return Promise.resolve();
        })
        .then(() => done.fail('should have rolled back the main transaction'))
        .catch((err) => {
            expect(err).toEqual(new Error('INNER_TRANSACTION_NOT_AWAITED'));
            // expect(zerv.notifyCreation.calls.count()).toEquals(0);
            done();
        });
    });
});

