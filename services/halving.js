const db = require('../db');

/// 🔥 Update halving based on eligible users
async function updateHalving() {

  /// users with ≥1000 successful mining sessions
  const result = await db.query(`
    SELECT COUNT(*) FROM users
    WHERE successful_sessions >= 1000
  `);

  const eligibleUsers = parseInt(result.rows[0].count);

  /// every 210,000 users = increase level
  const halvingCount = Math.floor(eligibleUsers / 210000);

  /// update global network stats
  await db.query(`
    UPDATE network_stats
    SET eligible_users = $1,
        halving_count = $2,
        updated_at = NOW()
  `, [eligibleUsers, halvingCount]);

  return {
    eligibleUsers,
    halvingCount
  };
}

module.exports = { updateHalving };