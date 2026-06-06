const db = require('../db');

async function main() {
  const columnsSql = `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name IN (
        'total_sessions', 'progress_percent', 'last_session_time', 'session_end_time',
        'notification_sent', 'ants_balance', 'is_eligible', 'pin_hash',
        'otp_code', 'otp_expiry', 'otp_attempts', 'is_trusted_device', 'preferred_language'
      )
    ORDER BY column_name
  `;

  const indexesSql = `
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'users'
      AND indexname IN ('idx_users_email', 'idx_users_session_end_time', 'idx_users_notification_sent')
    ORDER BY indexname
  `;

  const globalStatsSql = `SELECT id, total_ants_mined FROM global_stats LIMIT 1`;

  const [columns, indexes, globalStats] = await Promise.all([
    db.query(columnsSql),
    db.query(indexesSql),
    db.query(globalStatsSql),
  ]);

  console.log('columns:', columns.rows.map((r) => r.column_name).join(','));
  console.log('indexes:', indexes.rows.map((r) => r.indexname).join(','));
  console.log('global_stats:', JSON.stringify(globalStats.rows[0] || {}));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('verify-failed:', err.message || err);
    process.exit(1);
  });
