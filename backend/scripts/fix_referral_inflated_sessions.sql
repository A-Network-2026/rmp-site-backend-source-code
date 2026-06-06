-- FIX: Repair successful_sessions inflated by referral bonuses
-- Background: The old referral bonus code added +1 to the referrer's successful_sessions
-- for each referred user who completed their first session. This inflated their session
-- count above their actual mined sessions, potentially granting free coins via the
-- balance repair logic. This script corrects successful_sessions to match actual
-- completed mining sessions.
--
-- SAFE: Only decreases inflated counts; never increases.
-- IDEMPOTENT: Running multiple times is safe.

-- Step 1: Preview affected users (run this first to see impact)
-- SELECT
--   u.id,
--   u.email,
--   u.successful_sessions AS current_sessions,
--   COALESCE(ms.actual_completed, 0) AS actual_mined_sessions,
--   u.successful_sessions - COALESCE(ms.actual_completed, 0) AS inflated_by,
--   u.ants_balance,
--   u.ant_balance
-- FROM users u
-- LEFT JOIN (
--   SELECT user_id, COUNT(*)::int AS actual_completed
--   FROM mining_sessions
--   WHERE is_completed = TRUE AND COALESCE(status, '') = 'completed'
--   GROUP BY user_id
-- ) ms ON ms.user_id = u.id
-- WHERE u.successful_sessions > COALESCE(ms.actual_completed, 0)
-- ORDER BY (u.successful_sessions - COALESCE(ms.actual_completed, 0)) DESC;

-- Step 2: Fix successful_sessions to match actual completed mining sessions
UPDATE users u
SET successful_sessions = COALESCE(ms.actual_completed, 0),
    total_sessions = GREATEST(COALESCE(ms.actual_completed, 0), COALESCE(u.total_sessions, 0)),
    progress_percent = LEAST(100, (COALESCE(ms.actual_completed, 0)::double precision / 1000.0) * 100.0),
    is_eligible = (COALESCE(ms.actual_completed, 0) >= 1000),
    updated_at = NOW()
FROM (
  SELECT user_id, COUNT(*)::int AS actual_completed
  FROM mining_sessions
  WHERE is_completed = TRUE AND COALESCE(status, '') = 'completed'
  GROUP BY user_id
) ms
WHERE ms.user_id = u.id
  AND u.successful_sessions > ms.actual_completed;

-- Step 3: Also fix ants_balance if it's higher than what actual sessions earned.
-- This uses a conservative approach: ants_balance should not exceed
-- actual_sessions * ANTS_PER_SESSION (4882812 ANTS at stage-0 rate).
-- At higher halving stages the per-session reward is lower, so this floor is generous.
UPDATE users u
SET ants_balance = LEAST(
      GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint),
      COALESCE(ms.actual_completed, 0)::bigint * 4882812
    ),
    ant_balance = LEAST(
      GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint),
      COALESCE(ms.actual_completed, 0)::bigint * 4882812
    ),
    updated_at = NOW()
FROM (
  SELECT user_id, COUNT(*)::int AS actual_completed
  FROM mining_sessions
  WHERE is_completed = TRUE AND COALESCE(status, '') = 'completed'
  GROUP BY user_id
) ms
WHERE ms.user_id = u.id
  AND GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint)
      > COALESCE(ms.actual_completed, 0)::bigint * 4882812;
