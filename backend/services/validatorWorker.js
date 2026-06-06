'use strict';

/**
 * validatorWorker.js
 *
 * Background worker for the A Network Validator System.
 * Runs two periodic sweeps:
 *
 *  1. sweepInactiveValidators — suspends ACTIVE validators who have had
 *     no task activity for VALIDATOR_INACTIVITY_DAYS (default 7).
 *
 *  2. expireOverdueTasks — marks PENDING tasks whose deadline has passed
 *     as EXPIRED and applies a small reputation penalty.
 *
 * Start via: startValidatorWorker(db, intervalMs)
 */

const { sweepInactiveValidators, expireOverdueTasks } = require('./validatorEngine');

const DEFAULT_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.VALIDATOR_WORKER_INTERVAL_MS || 5 * 60_000)   // default 5 min
);

let workerTimer = null;

async function runValidatorSweep(db, log) {
  try {
    const suspended = await sweepInactiveValidators(db);
    if (suspended > 0 && log) {
      log.info({ suspended }, 'validator worker: inactive validators suspended');
    }
  } catch (err) {
    if (log) log.error(err, 'validator worker: sweepInactiveValidators failed');
  }

  try {
    const expired = await expireOverdueTasks(db);
    if (expired > 0 && log) {
      log.info({ expired }, 'validator worker: overdue tasks expired');
    }
  } catch (err) {
    if (log) log.error(err, 'validator worker: expireOverdueTasks failed');
  }
}

/**
 * @param {object} db         — pg Pool instance
 * @param {number} intervalMs — sweep interval in ms (default 5 min)
 * @param {object} [log]      — optional Fastify logger or console
 */
function startValidatorWorker(db, intervalMs, log) {
  const interval = Math.max(60_000, Number(intervalMs ?? DEFAULT_INTERVAL_MS));

  if (workerTimer) return; // already running

  // Run immediately on startup, then on interval
  runValidatorSweep(db, log);
  workerTimer = setInterval(() => runValidatorSweep(db, log), interval);
  workerTimer.unref?.(); // don't prevent process exit

  if (log) {
    log.info({ intervalMs: interval }, 'validator worker started');
  }
}

function stopValidatorWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

module.exports = { startValidatorWorker, stopValidatorWorker };
