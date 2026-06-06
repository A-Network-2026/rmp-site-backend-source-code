const db = require('../db');

async function main() {
  const tables = ['users', 'network_stats', 'mining_sessions', 'email_otp_codes'];
  for (const table of tables) {
    const exists = await db.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    if (!exists.rows[0].name) {
      console.log(`TABLE ${table}: not found`);
      continue;
    }

    const cols = await db.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = $1
       ORDER BY ordinal_position`,
      [table]
    );

    console.log(`TABLE ${table}:`, cols.rows.map((r) => r.column_name));
  }
}

main()
  .catch((e) => {
    console.error('INSPECT_FAILED', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_) {}
  });
