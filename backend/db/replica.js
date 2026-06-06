require('dotenv').config();
const { Pool } = require('pg');

const SLOW_QUERY_MS = Math.max(1, Number(process.env.DB_SLOW_QUERY_MS || 100));

function buildPoolConfig(prefix, fallbackMax = 10) {
  return {
    max: Math.max(2, Number(process.env[`${prefix}_MAX`] || process.env.PGPOOL_MAX || fallbackMax)),
    min: Math.max(0, Number(process.env[`${prefix}_MIN`] || process.env.PGPOOL_MIN || 2)),
    idleTimeoutMillis: Math.max(
      1000,
      Number(process.env[`${prefix}_IDLE_TIMEOUT_MS`] || process.env.PGPOOL_IDLE_TIMEOUT_MS || 30000)
    ),
    connectionTimeoutMillis: Math.max(
      1000,
      Number(process.env[`${prefix}_CONNECTION_TIMEOUT_MS`] || process.env.PGPOOL_CONNECTION_TIMEOUT_MS || 5000)
    ),
    keepAlive: String(process.env[`${prefix}_KEEPALIVE`] || process.env.PGPOOL_KEEPALIVE || 'true').toLowerCase() !== 'false',
    keepAliveInitialDelayMillis: Math.max(
      0,
      Number(process.env[`${prefix}_KEEPALIVE_INITIAL_DELAY_MS`] || process.env.PGPOOL_KEEPALIVE_INITIAL_DELAY_MS || 10000)
    ),
    statement_timeout: Math.max(
      1000,
      Number(process.env[`${prefix}_QUERY_TIMEOUT_MS`] || process.env.PGPOOL_QUERY_TIMEOUT_MS || 15000)
    ),
    query_timeout: Math.max(
      1000,
      Number(process.env[`${prefix}_QUERY_TIMEOUT_MS`] || process.env.PGPOOL_QUERY_TIMEOUT_MS || 15000)
    ),
  };
}

function trimSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function createReplicaPool() {
  const url = String(process.env.REPLICA_DATABASE_URL || '').trim();
  if (!url) {
    return null;
  }

  const sslMode = String(process.env.REPLICA_PGSSLMODE || process.env.PGSSLMODE || '').toLowerCase();
  const disableSsl = sslMode === 'disable';

  const pool = new Pool({
    ...buildPoolConfig('PG_REPLICA', 20),
    connectionString: url,
    ssl: disableSsl ? false : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    const code = err.code || '';
    if (code === '53300' || code === '53200' || code === '53100') {
      console.warn('[db][replica] pool resource pressure:', err.message);
      return;
    }
    console.error('[db][replica] unexpected pool error:', err.message, code);
  });

  return pool;
}

const replicaPool = createReplicaPool();

async function queryReplica(text, params) {
  if (!replicaPool) {
    throw new Error('Replica pool is not configured');
  }

  const started = Date.now();
  const result = await replicaPool.query(text, params);
  const elapsed = Date.now() - started;

  if (elapsed >= SLOW_QUERY_MS) {
    console.warn(`[db][replica][slow ${elapsed}ms] ${trimSql(text)}`);
  }

  return result;
}

module.exports = {
  pool: replicaPool,
  queryReplica,
};
