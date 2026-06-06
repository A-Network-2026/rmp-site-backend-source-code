require('dotenv').config();
const db = require('../db');

const wallets = process.argv.slice(2).map((value) => String(value || '').trim()).filter(Boolean);

if (wallets.length === 0) {
  console.error('Usage: node scripts/clear_wallet_restrictions.js <wallet> [wallet...]');
  process.exit(1);
}

async function loadUserColumns() {
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'`
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function userColumn(columns, name, fallbackSql) {
  return columns.has(name) ? name : fallbackSql;
}

function buildSelectionSql(columns) {
  const migrationWallet = columns.has('migration_wallet_address')
    ? 'migration_wallet_address'
    : 'NULL::text AS migration_wallet_address';

  return `
    SELECT
      id,
      ${userColumn(columns, 'email', 'NULL::text')} AS email,
      ${userColumn(columns, 'wallet_address', 'NULL::text')} AS wallet_address,
      ${userColumn(columns, 'custom_wallet_address', 'NULL::text')} AS custom_wallet_address,
      ${migrationWallet},
      ${userColumn(columns, 'successful_sessions', '0::bigint')} AS successful_sessions,
      ${userColumn(columns, 'total_sessions', '0::bigint')} AS total_sessions,
      ${userColumn(columns, 'is_eligible', 'FALSE')} AS is_eligible,
      ${userColumn(columns, 'is_banned', 'FALSE')} AS is_banned,
      ${userColumn(columns, 'is_flagged', 'FALSE')} AS is_flagged,
      ${userColumn(columns, 'flag_reason', "''::text")} AS flag_reason,
      ${userColumn(columns, 'ban_reason', "''::text")} AS ban_reason
    FROM users
    WHERE wallet_address = ANY($1)
       OR custom_wallet_address = ANY($1)
       ${columns.has('migration_wallet_address') ? 'OR migration_wallet_address = ANY($1)' : ''}
    ORDER BY id
  `;
}

function buildUpdateSql(columns) {
  const updates = [];
  if (columns.has('is_banned')) updates.push('is_banned = FALSE');
  if (columns.has('is_flagged')) updates.push('is_flagged = FALSE');
  if (columns.has('ban_reason')) updates.push('ban_reason = NULL');
  if (columns.has('flag_reason')) updates.push('flag_reason = NULL');
  if (columns.has('banned_at')) updates.push('banned_at = NULL');

  if (updates.length === 0) {
    return null;
  }

  return `
    UPDATE users
    SET ${updates.join(', ')}
    WHERE wallet_address = ANY($1)
       OR custom_wallet_address = ANY($1)
       ${columns.has('migration_wallet_address') ? 'OR migration_wallet_address = ANY($1)' : ''}
    RETURNING id,
              ${userColumn(columns, 'email', 'NULL::text')} AS email,
              ${userColumn(columns, 'wallet_address', 'NULL::text')} AS wallet_address,
              ${userColumn(columns, 'custom_wallet_address', 'NULL::text')} AS custom_wallet_address,
              ${columns.has('migration_wallet_address') ? 'migration_wallet_address' : 'NULL::text AS migration_wallet_address'},
              ${userColumn(columns, 'is_banned', 'FALSE')} AS is_banned,
              ${userColumn(columns, 'is_flagged', 'FALSE')} AS is_flagged
  `;
}

(async () => {
  await db.waitForDatabase({ attempts: 1, delayMs: 1 });

  const userColumns = await loadUserColumns();
  const selectionSql = buildSelectionSql(userColumns);
  const updateSql = buildUpdateSql(userColumns);

  const before = await db.query(selectionSql, [wallets]);
  console.log('Before:');
  console.log(JSON.stringify(before.rows, null, 2));

  if (updateSql) {
    const updated = await db.query(updateSql, [wallets]);
    console.log('Updated:');
    console.log(JSON.stringify(updated.rows, null, 2));
  } else {
    console.log('Updated: []');
  }

  const after = await db.query(selectionSql, [wallets]);
  console.log('After:');
  console.log(JSON.stringify(after.rows, null, 2));

  await db.end();
})().catch(async (error) => {
  console.error(error);
  try {
    await db.end();
  } catch {
    // ignore shutdown errors
  }
  process.exit(1);
});