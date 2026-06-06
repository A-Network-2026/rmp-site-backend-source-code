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

function createPrimaryPool() {
  const poolBaseConfig = buildPoolConfig('PG_PRIMARY', 10);

  if (process.env.DATABASE_URL) {
    const sslMode = String(process.env.PGSSLMODE || '').toLowerCase();
    const disableSsl = sslMode === 'disable';

    return new Pool({
      ...poolBaseConfig,
      connectionString: process.env.DATABASE_URL,
      ssl: disableSsl ? false : { rejectUnauthorized: false },
    });
  }

  return new Pool({
    ...poolBaseConfig,
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
  });
}

const primaryPool = createPrimaryPool();

function trimSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function queryPrimary(text, params) {
  const started = Date.now();
  const result = await primaryPool.query(text, params);
  const elapsed = Date.now() - started;

  if (elapsed >= SLOW_QUERY_MS) {
    console.warn(`[db][primary][slow ${elapsed}ms] ${trimSql(text)}`);
  }

  return result;
}

primaryPool.on('error', (err) => {
  const code = err.code || '';
  if (code === '53300' || code === '53200' || code === '53100') {
    console.warn('[db][primary] pool resource pressure:', err.message);
    return;
  }
  console.error('[db][primary] unexpected pool error:', err.message, code);
});

module.exports = {
  pool: primaryPool,
  queryPrimary,
};
