const db = require('../db');

async function main() {
  const columnsSql = `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name IN (
        'is_validator_candidate',
        'validator_status',
        'validator_key',
        'validator_joined_at',
        'validator_reputation'
      )
    ORDER BY column_name
  `;

  const indexesSql = `
    SELECT indexname
    FROM pg_indexes
    WHERE tablename = 'users'
      AND indexname = 'idx_users_validator_status'
  `;

  const sampleSql = `
    SELECT
      COUNT(*)::bigint AS total_users,
      COUNT(*) FILTER (WHERE COALESCE(is_validator_candidate, FALSE) = TRUE)::bigint AS validator_candidates,
      COUNT(*) FILTER (WHERE validator_status IS NULL OR validator_status = '')::bigint AS missing_validator_status
    FROM users
  `;

  const [columnsRes, indexesRes, sampleRes] = await Promise.all([
    db.query(columnsSql),
    db.query(indexesSql),
    db.query(sampleSql),
  ]);

  console.log('columns:', JSON.stringify(columnsRes.rows));
  console.log('indexes:', JSON.stringify(indexesRes.rows));
  console.log('summary:', JSON.stringify(sampleRes.rows[0] || {}));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('verify-failed:', err.message || err);
    process.exit(1);
  });
