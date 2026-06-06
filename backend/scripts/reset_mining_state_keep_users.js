const db = require('../db');

async function main() {
  await db.query('ALTER TABLE network_stats ADD COLUMN IF NOT EXISTS total_mined_ants NUMERIC(30,0) DEFAULT 0');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ant_balance NUMERIC(30,0) DEFAULT 0');

  await db.query('BEGIN');
  await db.query(`
    UPDATE users
    SET balance = 0,
        ant_balance = 0,
        successful_sessions = 0,
        is_mining = FALSE,
        last_mining_start = NULL,
        updated_at = NOW()
  `);

  await db.query('TRUNCATE TABLE mining_sessions RESTART IDENTITY');

  await db.query(`
    UPDATE network_stats
    SET total_users = (SELECT COUNT(*)::int FROM users WHERE COALESCE(is_deleted, FALSE) = FALSE),
        eligible_users = 0,
        halving_count = 0,
        total_mined = 0,
        total_mined_ants = 0,
        is_mining_active = TRUE,
        updated_at = NOW()
  `);

  await db.query('COMMIT');

  const stats = await db.query(
    'SELECT total_users, eligible_users, halving_count, total_mined, total_mined_ants, is_mining_active FROM network_stats LIMIT 1'
  );

  console.log('RESET_MINING_STATE_OK');
  console.log('network_stats:', stats.rows[0]);
}

main()
  .catch(async (err) => {
    try {
      await db.query('ROLLBACK');
    } catch (_) {}
    console.error('RESET_MINING_STATE_FAILED', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_) {}
  });
