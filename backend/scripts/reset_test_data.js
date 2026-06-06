const db = require('../db');

async function main() {
  const hasTable = async (name) => {
    const res = await db.query('SELECT to_regclass($1) AS name', [name]);
    return !!res.rows[0].name;
  };

  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE');
  await db.query('ALTER TABLE network_stats ADD COLUMN IF NOT EXISTS total_mined_ants NUMERIC(30,0) DEFAULT 0');
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_otp_codes (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      purpose VARCHAR(32) NOT NULL DEFAULT 'register',
      code_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  if (await hasTable('public.email_otp_codes')) {
    await db.query('TRUNCATE TABLE email_otp_codes RESTART IDENTITY');
  }
  if (await hasTable('public.mining_sessions')) {
    await db.query('TRUNCATE TABLE mining_sessions RESTART IDENTITY CASCADE');
  }
  await db.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  await db.query(`
    UPDATE network_stats
    SET eligible_users = 0,
        halving_count = 0,
        total_mined = 0,
      total_mined_ants = 0,
        is_mining_active = TRUE,
        updated_at = NOW()
  `);

  const users = await db.query('SELECT COUNT(*)::int AS total FROM users');
  const stats = await db.query(
    'SELECT eligible_users, halving_count, total_mined, total_mined_ants, is_mining_active FROM network_stats LIMIT 1'
  );

  console.log('RESET_OK');
  console.log('users:', users.rows[0]);
  console.log('network_stats:', stats.rows[0]);
}

main()
  .catch((err) => {
    console.error('RESET_FAILED', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_) {}
  });
