'use strict';
const Promise = require('promise');
const _ = require('lodash');
const zerv = require('../lib/zerv-core');

let defineTransaction;

describe('transaction', () => {
    const tenantId = 'tenantId1';
    const failedProcess = () => Promise.reject('A PROCESS ERROR');

    const successfullProcessWithNotifications = (transaction) => {
        transaction.notifyCreation(tenantId, 'MAGAZINE', {id: 1, description: 'super magazine'});
        return Promise.resolve();
    };
    const failedProcessWithNotifications = (transaction) => {
        transaction.notifyCreation(tenantId, 'MAGAZINE', {id: 1, description: 'super magazine'});
        return Promise.reject('A PROCESS ERROR');
    };

    beforeEach(() => {
        defineTransaction = zerv.defineTransaction;
        zerv.TransactionImplementationClass = DbTransactionImplementation;

        zerv.notifyCreation = _.noop;
        spyOn(zerv, 'notifyCreation');
    });


    it('should instantiate the correct transaction object', () => {
        const transaction = defineTransaction('NEW');
        expect(transaction instanceof DbTransactionImplementation).toBe(true);
        expect(transaction instanceof zerv.TransactionCoreClass).toBe(true);
        expect(transaction.query).toBeDefined();
    });


    it('should commit and notify sync', (done) => {
        defineTransaction('NEW')
        .execute(successfullProcessWithNotifications)
        .then(() => {
            expect(zerv.notifyCreation).toHaveBeenCalled();
            done();
        })
        .catch((err) => done.fail(err));
    });


    it('should rollback and never notify sync', (done) => {
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
            transaction.notifyCreation(tenantId, 'MAGAZINES', {id: 2, description: 'PEOPLE'});
            return defineTransaction('REUSE', transaction)
                .execute(successfullProcessWithNotifications);
        })
        .then(() => {
            expect(zerv.notifyCreation).toHaveBeenCalled();
            expect(zerv.notifyCreation.calls.count()).toEqual(2);
            done();
        })
        .catch((err) => done.fail(err));
    });


    it('should rollback due to inner transaction rollback and never notify sync', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            transaction.notifyCreation(tenantId, 'MAGAZINES', {id: 2, description: 'PEOPLE'});
            return defineTransaction('REUSE', transaction)
                .execute(failedProcessWithNotifications);
        })
        .then(() => done.fail('should have rolled back'))
        .catch(() => {
            expect(zerv.notifyCreation).not.toHaveBeenCalled();
            done();
        });
    });

    it('should rollback due to main transaction rollback and never notify sync', (done) => {
        defineTransaction('NEW')
        .execute((transaction) => {
            transaction.notifyCreation(tenantId, 'MAGAZINES', {id: 2, description: 'PEOPLE'});
            return defineTransaction('REUSE', transaction)
                .execute(successfullProcessWithNotifications)
                .then(() => transaction.rollback());
        })
        .then(() => done.fail('should have rolled back'))
        .catch(() => {
            expect(zerv.notifyCreation).not.toHaveBeenCalled();
            done();
        });
    });
});

class DbTransactionImplementation extends zerv.TransactionCoreClass {
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

    query(statement) {
        return Promise.resolve('SUCCESS');
    }
}

