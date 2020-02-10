const _ = require('lodash');
const zlog = require('zlog4js');
const logger = zlog.getLogger('zerv/activity');

const localActivities = [];

module.exports = {
    registerNewActivity,
    getActivitiesInProcess,
    pause,
    isServerPaused,
    _clearActivities
};


let pausePromise;

const ACTIVITY_STATUSES = {
    OK: 'ok',
    ERROR: 'error',
    IN_PROGRESS: 'running',
};


function _clearActivities() {
    localActivities.length = 0;
    pausePromise = null;
}
/**
 * this object will register any server activity that the server
 * must monitor in order to shutdown gracefully.
 *
 * so if developer needs to create a process that must complete before server shutdonws,
 * it must register the activity and call done() when it is finished.
 *
 * @param {String} name
 * @param {Object} params object that could be stored for statistics purposes when implemented
 *          to application, meaning the developped application relying on zerv registered the activity)
 *          ex:  tenantId would be useful to know which activities currently in process for a specific tenant
 * @param {Object} options:
 *      @property {String} origin: origin of the registration (api router and zerv distrib do set value, by default, origin is set
 * @returns {Object} which is the activity, with the following methods
 *         - done: to call when the activity is done
 *         - fail: to call when the activity failed.
 */
function registerNewActivity(name, params, options = {}) {
    const activity = {
        call: name,
        origin: options.origin || 'application',
        params,
        status: ACTIVITY_STATUSES.IN_PROGRESS,
        start: new Date(),
        end: null
    };
    const promise = new Promise((resolve) => {
        activity.done = () => {
            activity.status = ACTIVITY_STATUSES.OK;
            clearActivity(activity);
            resolve({status: activity.status});
        };
        activity.fail = (err) => {
            activity.status = ACTIVITY_STATUSES.ERROR;
            activity.error = err;
            clearActivity(activity);
            resolve({status: activity.status, error: err});
        };
    });
    activity.waitForCompletion = () => promise;

    localActivities.push(activity);
    return activity;
}

function clearActivity(activity) {
    activity.end = new Date();
  // we should consider removing the activity a little later
  // so that we could manage recent statistics on the server activity
    _.remove(localActivities, activity);
}

function getActivitiesInProcess() {
    return _.filter(localActivities, {status: ACTIVITY_STATUSES.IN_PROGRESS});
}


function isServerPaused() {
    return !_.isNil(pausePromise);
}

/**
 * server will wait for all activities to complete and pause, which means not taking more activities.
 * @param {Number} delayInSecs, default 10 seconds
 */
function pause(delayInSecs= 10) {
    if (!pausePromise) {
        logger.info(`Local server entering in pause and will not process more activities.`);
        pausePromise = new Promise((resolve) => {
            setTimeout(async () => {
                const localActivities = getActivitiesInProcess();
                const promises = _.map(localActivities, activity => activity.waitForCompletion());
                logger.info(`Waiting for ${localActivities.length} to complete...`);
                await Promise.all(promises);
                logger.info(`All activities on local server completed. Local server paused.`);
                resolve('done');
            }, delayInSecs * 1000);
        });
    }
    return pausePromise;
}
