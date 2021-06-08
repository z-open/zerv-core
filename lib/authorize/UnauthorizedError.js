// This class comes from socketio-auth
// this could get rearranged later on.
class UnauthorizedError extends Error {
    constructor(code, error) {
        super(error.message);
        this.inner = error;
        this.data = {
            message: this.message,
            code: code,
            type: 'UnauthorizedError'
        };
    }
    toJSON() {
        // only transport was is necessary
        return {
            message: this.message,
            data: this.data,
        };
    }
}

module.exports = UnauthorizedError;
