/**
 * recover_zero_balances.js
 *
 * One-shot recovery script for users whose ants_balance and ant_balance were
 * zeroed by the destructive backfill that ran with the e383aa3 deploy.
 *
 * Safe to run multiple times — only writes when the reconstruction produces a
 * value GREATER than what is currently stored (non-decreasing).
 *
 * Run from the backend/ directory:
 *   node scripts/recover_zero_balances.js
 */

'use strict';

const db = require('../db');
const ANTS_PER_ANET = 100_000_000;
const ANTS_PER_SESSION_FALLBACK = 4_882_812; // launch-tranche rate

async function main() {
  console.log('[recovery] Starting zero-balance recovery …');

  // ── 1. Diagnose ──────────────────────────────────────────────────────────
  const diagRes = await db.query(`
    SELECT COUNT(*) AS affected
    FROM users u
    WHERE (COALESCE(u.ants_balance, 0) = 0 OR COALESCE(u.ant_balance, 0) = 0)
      AND EXISTS (
        SELECT 1 FROM mining_sessions ms
        WHERE ms.user_id = u.id
          AND ms.is_completed = TRUE
          AND COALESCE(ms.status, '') = 'completed'
      )
  `);
  console.log(`[recovery] Users with zero ant balance but completed sessions: ${diagRes.rows[0].affected}`);

  // ── 2. Reconstruct from sessions ─────────────────────────────────────────
  const fixRes = await db.query(`
    WITH completed AS (
      SELECT
        ms.user_id,
        COUNT(*)::bigint                                                            AS session_count,
        COALESCE(SUM(ROUND(COALESCE(ms.reward, 0) * ${ANTS_PER_ANET})), 0)::bigint AS ants_from_rewards
      FROM mining_sessions ms
      WHERE ms.is_completed = TRUE
        AND COALESCE(ms.status, '') = 'completed'
      GROUP BY ms.user_id
    ),
    best_ants AS (
      SELECT
        c.user_id,
        GREATEST(
          c.ants_from_rewards,
          CASE
            WHEN c.ants_from_rewards = 0 AND c.session_count > 0
            THEN c.session_count * ${ANTS_PER_SESSION_FALLBACK}
            ELSE 0
          END
        ) AS ants_estimate
      FROM completed c
    )
    UPDATE users u
    SET
      ants_balance = GREATEST(
        COALESCE(u.ants_balance, 0),
        COALESCE(u.ant_balance, 0)::bigint,
        ROUND(COALESCE(u.balance, 0) * ${ANTS_PER_ANET})::bigint,
        b.ants_estimate
      ),
      ant_balance = GREATEST(
        COALESCE(u.ant_balance, 0),
        COALESCE(u.ants_balance, 0)::numeric,
        ROUND(COALESCE(u.balance, 0) * ${ANTS_PER_ANET})::numeric,
        b.ants_estimate::numeric
      )
    FROM best_ants b
    WHERE b.user_id = u.id
      AND b.ants_estimate > 0
    RETURNING u.id, u.ants_balance, u.ant_balance
  `);
  console.log(`[recovery] Rows restored from sessions: ${fixRes.rowCount}`);

  // ── 3. Also recover users with a non-zero legacy `balance` but zero ants ──
  const legacyRes = await db.query(`
    UPDATE users
    SET
      ants_balance = GREATEST(
        COALESCE(ants_balance, 0),
        COALESCE(ant_balance, 0)::bigint,
        ROUND(COALESCE(balance, 0) * ${ANTS_PER_ANET})::bigint
      ),
      ant_balance = GREATEST(
        COALESCE(ant_balance, 0),
        COALESCE(ants_balance, 0)::numeric,
        ROUND(COALESCE(balance, 0) * ${ANTS_PER_ANET})::numeric
      )
    WHERE COALESCE(balance, 0) > 0
      AND (COALESCE(ants_balance, 0) = 0 OR COALESCE(ant_balance, 0) = 0)
    RETURNING id, ants_balance, ant_balance
  `);
  console.log(`[recovery] Rows restored from legacy balance column: ${legacyRes.rowCount}`);

  // ── 4. Final sync pass ───────────────────────────────────────────────────
  await db.query(`
    UPDATE users
    SET
      ants_balance = GREATEST(COALESCE(ants_balance, 0), COALESCE(ant_balance, 0)::bigint),
      ant_balance  = GREATEST(COALESCE(ant_balance, 0),  COALESCE(ants_balance, 0)::numeric)
  `);
  console.log('[recovery] Final sync pass done.');

  // ── 5. Post-diagnosis ────────────────────────────────────────────────────
  const postRes = await db.query(`
    SELECT COUNT(*) AS still_zero
    FROM users u
    WHERE (COALESCE(u.ants_balance, 0) = 0 AND COALESCE(u.ant_balance, 0) = 0)
      AND EXISTS (
        SELECT 1 FROM mining_sessions ms
        WHERE ms.user_id = u.id
          AND ms.is_completed = TRUE
          AND COALESCE(ms.status, '') = 'completed'
      )
  `);
  console.log(`[recovery] Users still at zero after fix (legitimately flagged): ${postRes.rows[0].still_zero}`);
  console.log('[recovery] Done.');

  process.exit(0);
}

main().catch((err) => {
  console.error('[recovery] FATAL:', err);
  process.exit(1);
});
