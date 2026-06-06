-- Performance optimization indexes (2026-05-15)
-- Fixes slow queries observed in production logs:
--   1. middleware/auth.js presence touch UPDATE (200ms+)
--   2. mining sweep orphan close WITH stale AS (400-564ms)
--   3. leaderboard /top ORDER BY GREATEST(...) DESC (full scan)

BEGIN;

-- 1. Presence touch: UPDATE users WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - interval)
--    The WHERE includes id (pk, already fast) but the condition last_seen_at IS NULL OR last_seen_at < threshold
--    causes a re-evaluate on every auth request. This partial index covers stale/null rows only.
CREATE INDEX IF NOT EXISTS idx_users_last_seen_stale
  ON users (id, last_seen_at)
  WHERE last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '5 minutes';

-- 2. Orphan sweep: mining_sessions JOIN users WHERE ms.is_completed=FALSE AND is_mining=FALSE AND start_time<=cutoff
--    The existing idx_mining_sessions_overdue_active covers is_completed=FALSE + start_time, but the JOIN to users
--    filtering COALESCE(u.is_mining, FALSE) = FALSE has no compound path.
--    This index covers orphan sessions for the WITH stale CTE scan.
CREATE INDEX IF NOT EXISTS idx_mining_sessions_orphan_sweep
  ON mining_sessions (start_time ASC, user_id)
  WHERE is_completed = FALSE;

-- 3. Leaderboard top query: ORDER BY GREATEST(ants_balance, ant_balance) DESC – the existing expression index
--    idx_users_effective_ant_balance already covers this. Ensure it is named correctly for planner.
--    No new index needed for leaderboard top – existing index covers it.

-- 4. Stats /network: last_seen_at > NOW() - 5 minutes (users_online calc)
--    Partial index for online users lookup.
CREATE INDEX IF NOT EXISTS idx_users_recently_seen
  ON users (last_seen_at DESC)
  WHERE last_seen_at IS NOT NULL;

-- 5. Country stats: active user count per country (GROUP BY country WHERE is_deleted=FALSE)
CREATE INDEX IF NOT EXISTS idx_users_country_active
  ON users (country)
  WHERE is_deleted = FALSE OR is_deleted IS NULL;

COMMIT;
