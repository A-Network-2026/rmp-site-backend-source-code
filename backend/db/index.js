require('dotenv').config();

const { pool: primaryPool, queryPrimary } = require('./primary');
const { pool: replicaPool, queryReplica } = require('./replica');

const REPLICA_RETRY_ATTEMPTS = Math.max(0, Number(process.env.REPLICA_QUERY_RETRIES || 1));
const REPLICA_RETRY_DELAY_MS = Math.max(0, Number(process.env.REPLICA_RETRY_DELAY_MS || 120));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isReplicaTemporaryError(err) {
  const code = String(err?.code || '');
  if (['57P01', '57P02', '57P03', '53300', '53200', '53100', '08000', '08001', '08006'].includes(code)) {
    return true;
  }

  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('connection') || msg.includes('read only transaction');
}

async function waitForDatabase(options = {}) {
  const attempts = Number(options.attempts || process.env.DB_STARTUP_RETRIES || 30);
  const delayMs = Number(options.delayMs || process.env.DB_STARTUP_RETRY_MS || 2000);

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await queryPrimary('SELECT 1');
      console.log('OK PostgreSQL primary connected');

      if (replicaPool) {
        try {
          await queryReplica('SELECT 1');
          console.log('OK PostgreSQL replica connected');
        } catch (replicaErr) {
          console.warn('WARN PostgreSQL replica check failed on startup (continuing):', replicaErr.message);
        }
      }

      return true;
    } catch (err) {
      lastError = err;
      console.error(`DB connection error (attempt ${attempt}/${attempts}):`, err.message || err);
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

async function readQuery(text, params, options = {}) {
  const forcePrimary = Boolean(options.forcePrimary);
  if (forcePrimary || !replicaPool) {
    return queryPrimary(text, params);
  }

  let attempt = 0;
  let lastError = null;
  const maxAttempts = 1 + REPLICA_RETRY_ATTEMPTS;

  while (attempt < maxAttempts) {
    try {
      return await queryReplica(text, params);
    } catch (err) {
      lastError = err;
      attempt += 1;
      if (attempt < maxAttempts && isReplicaTemporaryError(err)) {
        if (REPLICA_RETRY_DELAY_MS > 0) {
          await sleep(REPLICA_RETRY_DELAY_MS);
        }
        continue;
      }
      break;
    }
  }

  console.warn('[db][replica] read failed, falling back to primary:', lastError?.message || lastError);
  return queryPrimary(text, params);
}

async function writeQuery(text, params) {
  return queryPrimary(text, params);
}

module.exports = {
  query: writeQuery,
  writeQuery,
  readQuery,
  connect: (...args) => primaryPool.connect(...args),
  end: async () => {
    const tasks = [primaryPool.end()];
    if (replicaPool) {
      tasks.push(replicaPool.end());
    }
    await Promise.all(tasks);
  },
  waitForDatabase,
  get waitingCount() {
    return Number(primaryPool.waitingCount || 0);
  },
  get idleCount() {
    return Number(primaryPool.idleCount || 0);
  },
  get totalCount() {
    return Number(primaryPool.totalCount || 0);
  },
  get replicaWaitingCount() {
    return Number(replicaPool?.waitingCount || 0);
  },
  get replicaIdleCount() {
    return Number(replicaPool?.idleCount || 0);
  },
  get replicaTotalCount() {
    return Number(replicaPool?.totalCount || 0);
  },
};
