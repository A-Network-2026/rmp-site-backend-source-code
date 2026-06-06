/**
 * Migration 002: add PIN-keyed seed encryption columns to users table.
 * Usage: node scripts/run_migration_002_pin_seed.js
 */
const db = require('../db');

async function main() {
  console.log('[Migration 002] Adding PIN-encrypted seed columns...');

  await db.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS wallet_seed_pin_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS wallet_seed_pin_iv        TEXT,
      ADD COLUMN IF NOT EXISTS wallet_seed_pin_tag       TEXT;
  `);

  console.log('[Migration 002] Done. New columns: wallet_seed_pin_encrypted, wallet_seed_pin_iv, wallet_seed_pin_tag');

  const check = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name IN ('wallet_seed_pin_encrypted', 'wallet_seed_pin_iv', 'wallet_seed_pin_tag')
    ORDER BY column_name
  `);
  console.log('[Migration 002] Verified columns present:', check.rows.map((r) => r.column_name));

  process.exit(0);
}

main().catch((err) => {
  console.error('[Migration 002] FAILED:', err);
  process.exit(1);
});
