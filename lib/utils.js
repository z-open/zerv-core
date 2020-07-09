const _ = require('lodash');
const service = {
    setLongTimeout,
    clearLongTimeout,
    _setTimeout
};

module.exports = service;

// Node timeout cannot handle more than about 24.9 days
// internally uses a signed 32 bit

const MAX_TIMEOUT_DAYS = 20;

class Timeout {
    constructor(fn, valueInMins) {
        this.fn = fn;
        this.remainingDays = Math.trunc(valueInMins / (60*24));
        if (this.remainingDays > MAX_TIMEOUT_DAYS) {
            this.remainingMins = valueInMins-(this.remainingDays * 24 * 60);
        } else {
            this.remainingMins = valueInMins;
            this.remainingDays = 0;
        }
        this._setTimeout();
    }
    _setTimeout() {
        if (this.remainingDays <= MAX_TIMEOUT_DAYS) {
            const remaining = (this.remainingDays * 24 * 60) + this.remainingMins;
            if (remaining=== 0) {
                this.fn();
            } else {
                this.timeout = service._setTimeout(this.fn, remaining * 60 * 1000);
            }
        } else {
            // reduced the number of times to timeout.
            this.timeout = service._setTimeout(() => {
                this.remainingDays -= MAX_TIMEOUT_DAYS;
                this.timeout = this._setTimeout();
            }, MAX_TIMEOUT_DAYS * 24 * 60 * 60 * 1000);
        }
    }
    destroy() {
        clearTimeout(this.timeout);
    }
}
function setLongTimeout(fn, value, options = {}) {
    if (_.isNumber(options.max) && value > options.max) {
        value = options.max;
    }
    return new Timeout(fn, value);
}

function clearLongTimeout(timeout) {
    if (!_.isNil(timeout)) {
        timeout.destroy();
    }
}

function _setTimeout(fn, value) {
    return setTimeout(fn, value);
}
