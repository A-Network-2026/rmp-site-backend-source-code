'use strict';

/**
 * schemaGuard.js — safe startup DDL helpers
 *
 * Problem: unconditional ALTER TABLE … ADD COLUMN statements on every boot
 * acquire AccessExclusiveLock on the target table. If any long-running query
 * holds a ShareLock, the ALTER queues — and every subsequent read of that table
 * also queues behind it (Postgres FIFO lock queue). With a 15 s
 * statement_timeout this causes a restart loop.
 *
 * Solution: check information_schema.columns first (cheap, no table lock).
 * Only issue the ALTER when the column genuinely does not exist, and do so
 * inside a per-client transaction with a short lock_timeout so the DDL fails
 * fast rather than blocking readers.
 *
 * Kill switch: set RUN_STARTUP_SCHEMA_MIGRATIONS=false to skip all migrations.
 */

const db = require('../db');

const ENABLED = String(process.env.RUN_STARTUP_SCHEMA_MIGRATIONS ?? 'true').trim().toLowerCase() !== 'false';
const LOCK_TIMEOUT_MS = Math.max(Number(process.env.SCHEMA_MIGRATION_LOCK_TIMEOUT_MS || 3000), 500);

/**
 * Returns true if the given column exists on the given table.
 * Uses information_schema — never locks the table being checked.
 */
async function columnExists(table, column, client) {
  const q = client ? (...a) => client.query(...a) : (...a) => db.query(...a);
  const res = await q(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name  = $1
       AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return res.rows.length > 0;
}

/**
 * Returns true if the given index exists.
 */
async function indexExists(indexName, client) {
  const q = client ? (...a) => client.query(...a) : (...a) => db.query(...a);
  const res = await q(
    `SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname  = $1
     LIMIT 1`,
    [indexName]
  );
  return res.rows.length > 0;
}

/**
 * Adds a column only if it is missing.
 * @param {string} table       - table name
 * @param {string} column      - column name
 * @param {string} definition  - SQL type + constraints, e.g. "BIGINT DEFAULT 0"
 * @param {object} [opts]
 * @param {object} [opts.logger]  - fastify/pino logger (optional)
 * @param {object} [opts.client]  - existing pg client (optional; one is created if not provided)
 */
async function addColumnIfMissing(table, column, definition, opts = {}) {
  if (!ENABLED) return;
  const { logger } = opts;

  const client = await db.connect();
  try {
    const exists = await columnExists(table, column, client);
    if (exists) return;

    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${LOCK_TIMEOUT_MS + 2000}ms'`);
    await client.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`
    );
    await client.query('COMMIT');
    if (logger) logger.info(`schemaGuard: added column ${table}.${column}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (logger) {
      logger.warn({ err }, `schemaGuard: skipped ${table}.${column} (lock contention or already exists)`);
    }
    // Non-fatal — if the column already existed the query would have been a no-op anyway
  } finally {
    client.release();
  }
}

/**
 * Creates an index only if it does not already exist.
 * @param {string} indexName  - index name (used for the existence check)
 * @param {string} sql        - full CREATE INDEX … statement
 * @param {object} [opts]
 */
async function createIndexIfMissing(indexName, sql, opts = {}) {
  if (!ENABLED) return;
  const { logger } = opts;

  const exists = await indexExists(indexName);
  if (exists) return;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${LOCK_TIMEOUT_MS + 2000}ms'`);
    await client.query(sql);
    await client.query('COMMIT');
    if (logger) logger.info(`schemaGuard: created index ${indexName}`);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (logger) logger.warn({ err }, `schemaGuard: skipped index ${indexName}`);
  } finally {
    client.release();
  }
}

/**
 * Runs arbitrary DDL inside a transaction with bounded lock_timeout.
 * Safe to call even if the change is already applied (caller must handle that).
 * @param {string}   sql     - DDL statement
 * @param {Array}    [params] - bind parameters
 * @param {object}   [opts]
 */
async function runDDLWithLockTimeout(sql, params = [], opts = {}) {
  if (!ENABLED) return;
  const { logger } = opts;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${LOCK_TIMEOUT_MS + 2000}ms'`);
    await client.query(sql, params);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (logger) logger.warn({ err, sql }, 'schemaGuard: DDL skipped (lock contention or already applied)');
  } finally {
    client.release();
  }
}

module.exports = { columnExists, indexExists, addColumnIfMissing, createIndexIfMissing, runDDLWithLockTimeout };
