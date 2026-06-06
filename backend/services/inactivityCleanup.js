/**
 * 🧹 INACTIVITY CLEANUP SERVICE
 * Manages cleanup of inactive accounts (30+ days inactive)
 * Returns mined coins to ecosystem
 */

const db = require('../db');

const INACTIVITY_THRESHOLD_DAYS = 30;

async function getUsersColumns() {
  const res = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'users'`
  );
  return new Set(res.rows.map((r) => r.column_name));
}

function pickFirstExisting(columns, candidates) {
  for (const name of candidates) {
    if (columns.has(name)) return name;
  }
  return null;
}

/**
 * 🔄 Return coins to ecosystem when account is cleaned up
 */
async function returnCoinsToEcosystem(userId, antBalance) {
  if (antBalance <= 0) return;

  // Log the return transaction
  await db.query(
    `INSERT INTO ant_transactions (user_id, transaction_type, amount, description, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, 'ecosystem_return', antBalance, 'Account inactive 30+ days - coins returned to ecosystem for redistribution', 'completed']
  );

  // Update network stats - these coins are now available for future mining
  await db.query(
    `UPDATE network_stats
     SET total_mined_ants = GREATEST(COALESCE(total_mined_ants, 0) - $1, 0),
         total_mined = ROUND(GREATEST(COALESCE(total_mined_ants, 0) - $1, 0) / 100000000.0, 8)
     WHERE id = (SELECT id FROM network_stats LIMIT 1)`,
    [antBalance]
  );
}

/**
 * 🗑️ Clean up inactive accounts
 * - Older than 30 days without activity
 * - Returns all mined ANT coins to ecosystem
 * - Soft deletes the account
 */
async function cleanupInactiveAccounts() {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - INACTIVITY_THRESHOLD_DAYS);

    const usersColumns = await getUsersColumns();
    const balanceColumn = pickFirstExisting(usersColumns, ['ant_balance', 'balance']);
    const activityColumn = pickFirstExisting(usersColumns, ['last_activity_at', 'updated_at', 'created_at']);

    if (!activityColumn) {
      console.warn('[InactivityCleanup] Skipped: no activity timestamp column found on users table');
      return {
        success: false,
        error: 'No activity timestamp column found on users table',
      };
    }

    const hasIsDeleted = usersColumns.has('is_deleted');
    const hasDeletedAt = usersColumns.has('deleted_at');
    const hasEmailVerified = usersColumns.has('email_verified');

    // Find inactive users
    const selectBalance = balanceColumn ? `COALESCE(${balanceColumn}, 0) AS ant_balance` : '0::numeric AS ant_balance';
    const whereDeleted = hasIsDeleted ? 'COALESCE(is_deleted, FALSE) = FALSE' : 'TRUE';
    const whereVerified = hasEmailVerified ? 'COALESCE(email_verified, FALSE) = TRUE' : 'TRUE';

    const inactiveUsers = await db.query(
      `SELECT id, email, ${selectBalance}
       FROM users
       WHERE ${whereDeleted}
         AND ${activityColumn} < $1
         AND ${whereVerified}`,
      [thirtyDaysAgo]
    );

    console.log(`[InactivityCleanup] Found ${inactiveUsers.rows.length} inactive accounts`);

    for (const user of inactiveUsers.rows) {
      try {
        // Return coins to ecosystem
        if (user.ant_balance > 0) {
          await returnCoinsToEcosystem(user.id, user.ant_balance);
        }

        // Soft delete the account
        const setClauses = [];
        if (hasIsDeleted) setClauses.push('is_deleted = TRUE');
        if (hasDeletedAt) setClauses.push('deleted_at = NOW()');
        if (usersColumns.has('ant_balance')) setClauses.push('ant_balance = 0');
        if (usersColumns.has('balance')) setClauses.push('balance = 0');
        if (!usersColumns.has('ant_balance') && balanceColumn) setClauses.push(`${balanceColumn} = 0`);

        if (setClauses.length > 0) {
          await db.query(
            `UPDATE users
             SET ${setClauses.join(', ')}
             WHERE id = $1`,
            [user.id]
          );
        }

        console.log(`[InactivityCleanup] Cleaned up user ${user.email} (ID: ${user.id}) - Returned ${user.ant_balance} ANT to ecosystem`);
      } catch (err) {
        console.error(`[InactivityCleanup] Error cleaning up user ${user.email}:`, err.message);
      }
    }

    return {
      success: true,
      cleanedUpCount: inactiveUsers.rows.length,
      totalANTReturned: inactiveUsers.rows.reduce((sum, u) => sum + (u.ant_balance || 0), 0),
    };
  } catch (err) {
    console.error('[InactivityCleanup] Fatal error:', err);
    return {
      success: false,
      error: err.message,
    };
  }
}

/**
 * 📊 Get statistics on inactive accounts
 */
async function getInactivityStats() {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - INACTIVITY_THRESHOLD_DAYS);

    const usersColumns = await getUsersColumns();
    const balanceColumn = pickFirstExisting(usersColumns, ['ant_balance', 'balance']);
    const activityColumn = pickFirstExisting(usersColumns, ['last_activity_at', 'updated_at', 'created_at']);

    if (!activityColumn) {
      console.warn('[InactivityStats] Skipped: no activity timestamp column found on users table');
      return null;
    }

    const hasIsDeleted = usersColumns.has('is_deleted');
    const hasEmailVerified = usersColumns.has('email_verified');
    const whereDeleted = hasIsDeleted ? 'COALESCE(is_deleted, FALSE) = FALSE' : 'TRUE';
    const whereVerified = hasEmailVerified ? 'COALESCE(email_verified, FALSE) = TRUE' : 'TRUE';
    const sumExpr = balanceColumn ? `COALESCE(SUM(${balanceColumn}), 0)::numeric` : '0::numeric';
    const countWithBalance = balanceColumn
      ? `COUNT(*) FILTER (WHERE COALESCE(${balanceColumn}, 0) > 0)::int`
      : '0::int';

    const stats = await db.query(
      `SELECT
         COUNT(*)::int AS total_inactive_accounts,
         ${sumExpr} AS total_ant_at_risk,
         ${countWithBalance} AS accounts_with_balance
       FROM users
       WHERE ${whereDeleted}
         AND ${activityColumn} < $1
         AND ${whereVerified}`,
      [thirtyDaysAgo]
    );

    return stats.rows[0];
  } catch (err) {
    console.error('[InactivityStats] Error:', err);
    return null;
  }
}

module.exports = {
  cleanupInactiveAccounts,
  getInactivityStats,
  INACTIVITY_THRESHOLD_DAYS,
};
