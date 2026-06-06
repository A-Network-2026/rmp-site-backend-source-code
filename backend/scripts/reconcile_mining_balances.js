'use strict';

const db = require('../db');

const ANTS_PER_ANET = 100_000_000;
const ANTS_PER_SESSION_FALLBACK = 4_882_812;
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`[reconcile] Mode: ${APPLY ? 'apply' : 'dry-run'}`);

  const query = `
    WITH completed AS (
      SELECT
        ms.user_id,
        COUNT(*)::bigint AS completed_sessions,
        COALESCE(SUM(ROUND(COALESCE(ms.reward, 0) * ${ANTS_PER_ANET})), 0)::bigint AS ants_from_rewards
      FROM mining_sessions ms
      WHERE ms.is_completed = TRUE
        AND COALESCE(ms.status, '') = 'completed'
      GROUP BY ms.user_id
    ),
    derived AS (
      SELECT
        u.id,
        u.email,
        COALESCE(c.completed_sessions, 0) AS actual_completed_sessions,
        COALESCE(u.successful_sessions, 0) AS stored_successful_sessions,
        COALESCE(u.total_sessions, 0) AS stored_total_sessions,
        GREATEST(
          COALESCE(u.ants_balance, 0),
          COALESCE(u.ant_balance, 0)::bigint
        ) AS stored_effective_ants,
        COALESCE(u.claimed_anet, 0) AS claimed_anet,
        GREATEST(
          COALESCE(c.ants_from_rewards, 0),
          CASE
            WHEN COALESCE(c.ants_from_rewards, 0) = 0 AND COALESCE(c.completed_sessions, 0) > 0
              THEN COALESCE(c.completed_sessions, 0) * ${ANTS_PER_SESSION_FALLBACK}
            ELSE 0
          END
        ) AS derived_total_ants
      FROM users u
      LEFT JOIN completed c ON c.user_id = u.id
    ),
    expected AS (
      SELECT
        id,
        email,
        actual_completed_sessions,
        stored_successful_sessions,
        stored_total_sessions,
        stored_effective_ants,
        claimed_anet,
        derived_total_ants,
        GREATEST(
          derived_total_ants - ROUND(COALESCE(claimed_anet, 0) * ${ANTS_PER_ANET})::bigint,
          0
        ) AS expected_remaining_ants
      FROM derived
    )
    SELECT
      id,
      email,
      actual_completed_sessions,
      stored_successful_sessions,
      stored_total_sessions,
      stored_effective_ants,
      claimed_anet,
      derived_total_ants,
      expected_remaining_ants,
      GREATEST(actual_completed_sessions - stored_successful_sessions, 0) AS missing_successful_sessions,
      GREATEST(actual_completed_sessions - stored_total_sessions, 0) AS missing_total_sessions,
      GREATEST(expected_remaining_ants - stored_effective_ants, 0) AS missing_ants
    FROM expected
    WHERE actual_completed_sessions > stored_successful_sessions
       OR actual_completed_sessions > stored_total_sessions
       OR expected_remaining_ants > stored_effective_ants
    ORDER BY missing_ants DESC, missing_successful_sessions DESC, id ASC
  `;

  const previewRes = await db.query(query);
  console.log(`[reconcile] Users needing repair: ${previewRes.rowCount}`);

  const previewSample = previewRes.rows.slice(0, 20);
  for (const row of previewSample) {
    console.log(
      `[reconcile] user=${row.id} email=${row.email || '-'} ` +
      `storedAnts=${row.stored_effective_ants} expectedAnts=${row.expected_remaining_ants} ` +
      `storedSessions=${row.stored_successful_sessions}/${row.stored_total_sessions} ` +
      `actualSessions=${row.actual_completed_sessions} claimedAnet=${row.claimed_anet}`
    );
  }

  if (!APPLY) {
    console.log('[reconcile] Dry-run complete. Re-run with --apply to persist changes.');
    process.exit(0);
  }

  const applyRes = await db.query(`
    WITH completed AS (
      SELECT
        ms.user_id,
        COUNT(*)::bigint AS completed_sessions,
        COALESCE(SUM(ROUND(COALESCE(ms.reward, 0) * ${ANTS_PER_ANET})), 0)::bigint AS ants_from_rewards
      FROM mining_sessions ms
      WHERE ms.is_completed = TRUE
        AND COALESCE(ms.status, '') = 'completed'
      GROUP BY ms.user_id
    ),
    expected AS (
      SELECT
        u.id,
        COALESCE(c.completed_sessions, 0) AS actual_completed_sessions,
        GREATEST(
          COALESCE(c.ants_from_rewards, 0),
          CASE
            WHEN COALESCE(c.ants_from_rewards, 0) = 0 AND COALESCE(c.completed_sessions, 0) > 0
              THEN COALESCE(c.completed_sessions, 0) * ${ANTS_PER_SESSION_FALLBACK}
            ELSE 0
          END
        ) AS derived_total_ants,
        ROUND(COALESCE(u.claimed_anet, 0) * ${ANTS_PER_ANET})::bigint AS claimed_ants,
        GREATEST(
          COALESCE(u.ants_balance, 0),
          COALESCE(u.ant_balance, 0)::bigint
        ) AS stored_effective_ants
      FROM users u
      LEFT JOIN completed c ON c.user_id = u.id
    ),
    repairs AS (
      SELECT
        id,
        actual_completed_sessions,
        GREATEST(derived_total_ants - claimed_ants, 0) AS expected_remaining_ants,
        stored_effective_ants
      FROM expected
      WHERE actual_completed_sessions > 0
    )
    UPDATE users u
    SET successful_sessions = GREATEST(COALESCE(u.successful_sessions, 0), r.actual_completed_sessions),
        total_sessions = GREATEST(COALESCE(u.total_sessions, 0), r.actual_completed_sessions),
        ants_balance = GREATEST(COALESCE(u.ants_balance, 0), r.expected_remaining_ants),
        ant_balance = GREATEST(COALESCE(u.ant_balance, 0), r.expected_remaining_ants::numeric),
        progress_percent = LEAST(
          100,
          (GREATEST(COALESCE(u.total_sessions, 0), r.actual_completed_sessions)::double precision / 1000.0) * 100.0
        ),
        is_eligible = GREATEST(COALESCE(u.total_sessions, 0), r.actual_completed_sessions) >= 1000
    FROM repairs r
    WHERE u.id = r.id
      AND (
        r.actual_completed_sessions > COALESCE(u.successful_sessions, 0)
        OR r.actual_completed_sessions > COALESCE(u.total_sessions, 0)
        OR r.expected_remaining_ants > GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint)
      )
    RETURNING u.id, u.email, u.successful_sessions, u.total_sessions, u.ants_balance, u.ant_balance
  `);

  console.log(`[reconcile] Rows repaired: ${applyRes.rowCount}`);
  console.log('[reconcile] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[reconcile] FATAL:', err);
  process.exit(1);
});