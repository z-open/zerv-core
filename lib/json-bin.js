'strict mode';

(function () {
    var root = this;
    var previous_JSONBIN = root.JSONBIN;
    var logger;
    var _;

    const JSONBIN = {
        serialize,
        deserialize
    };

    if (typeof exports !== 'undefined') {

        if (require) {
            var zlog = require('zlog');
            _ = require('lodash');
            msgpack = require("msgpack-lite"); // seems faster than msgpack5 always or way more than jsonpack
            logger = zlog.getLogger('zerv/sync/jsonbin');
            logger.setLevel('all')
        }

        if (typeof module !== 'undefined' && module.exports) {
            exports = module.exports = JSONBIN
        }
        exports.JSONBIN = JSONBIN
    }
    else {
        root.JSONBIN = JSONBIN;
        _ = root._;
        msgpack = root.msgpack5();
        logger = { debug: console.debug };
    }


    /**
     * 
     * Serialize object. 
     * during the process the object will be jsonify (toJSON inner objects will also be called) and optimized for size reduction (Dictionary)
     * then zipped.
     * 
     * @param {*} obj 
     * @param {*} debug 
     * 
     * @returns {Uint8Array}
     */
    function serialize(obj, debug) {
        debug =true;
        if (_.isNil(obj)) {
            return;
        }
        const start = Date.now();

        const cJson = pack(obj);
        const serializedObj = msgpack.encode(cJson);
        debug && logger.debug('Serialize object to size %b in %b',
            getSizeFormat(serializedObj.length), getTimeFormat(Date.now() - start));
        return serializedObj;

        // const jsonText = JSON.stringify(obj);
        // const jsonT = Date.now();

        // const jsonParse = jsonify(obj);
        // const jsonP = Date.now();

        // const packed = msgpack.encode(jsonParse);
        // //jsonpack.pack(jsonParse);
        // const packedT = Date.now();
        // const compression = Math.round(Number(100 * packed.length / jsonText.length) * 10) / 10;

        // debug && logger.debug('Serialize object to size %b, compressed to %b - jtext %b - jparse %b - packed %b',
        //     getSizeFormat(packed.length), compression + '%',
        //     getTimeFormat(jsonT - start),
        //     getTimeFormat(jsonP - jsonT),
        //     getTimeFormat(packedT - jsonP));
        // return packed;

    }

    /**
     * 
     * @param {Uint8Array} serializedObj 
     * @return {json}
     */
    function deserialize(serializedObj) {
        if (_.isNil(serializedObj)) {
            return;
        }
        const cJson = msgpack.decode(serializedObj);
        return unpack(cJson);
    }

    function getSizeFormat(v) {
        return (v > 1000 ? (Math.round(v / 10) / 100) + 'Kb' : v + 'b')
    }
    function getTimeFormat(lap) {
        return lap >= 1000 ? Math.round((lap) / 100) / 10 + 's' : lap + 'ms';
    }

    function pack(obj) {
        const dictionaryNames = {}, dictionary = [];
        let n = 0;
        const r = _.cloneDeepWith(obj, processProperty);
        r.$d = dictionary;
        return r;

        function processProperty(objProperty) {
            if (objProperty.toJSON) {
                objProperty = objProperty.toJSON();
            }
            if (_.isArray(objProperty)) {
                return _.map(objProperty, function (item) {
                    if (_.isNil(objProperty)) {
                        return null;
                    }
                    return _.cloneDeepWith(item, processProperty);
                })
            }
            if (_.isObject(objProperty)) {
                const newObj = {};
                for (var property in objProperty) {
                    if (!_.isNil(objProperty[property]) && !_.isFunction(objProperty[property])) {
                        var d = dictionaryNames[property];
                        if (d == null) {
                            d = (n++).toString(36);
                            dictionaryNames[property] = d;
                            dictionary.push(property);
                        }

                        newObj[d] = _.cloneDeepWith(objProperty[property], processProperty);
                    }
                }
                return newObj;
            }
            return objProperty;
        };
    }

    /**
     * 
     * @param {*} packedObj 
     */
    function unpack(packedObj) {
        const dictionary = packedObj.$d;
        delete packedObj.$d;
        const r = _.cloneDeepWith(packedObj, processProperty);
        return r;

        function processProperty(objProperty) {
            if (_.isArray(objProperty)) {
                return _.map(objProperty, function (item) {
                    if (_.isNil(objProperty)) {
                        return null;
                    }
                    return _.cloneDeepWith(item, processProperty);
                });
            }
            if (_.isObject(objProperty)) {
                //console.log(objProperty.constructor.name);
                const newObj = {};
                for (var property in objProperty) {
                    if (!_.isNil(objProperty[property]) && !_.isFunction(objProperty[property])) {
                        var d = dictionary[parseInt(property, 36)];
                        newObj[d] = _.cloneDeepWith(objProperty[property], processProperty);
                    }
                }
                return newObj;
            }
            return objProperty;
        };

    }

}).call(this);