BEGIN;

-- Core user columns for session-based mining + i18n + smart OTP.
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_sessions INTEGER DEFAULT 0 CHECK (total_sessions >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS progress_percent DOUBLE PRECISION DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_session_time TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_end_time TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ants_balance BIGINT DEFAULT 0 CHECK (ants_balance >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_eligible BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expiry TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_attempts INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trusted_device BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en' NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS device_token TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ip_address TEXT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0;

-- Backward-compatible ants field bridge if old column exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'ant_balance'
  ) THEN
    UPDATE users
    SET ants_balance = GREATEST(COALESCE(ants_balance, 0), COALESCE(ant_balance, 0)::bigint)
    WHERE COALESCE(ants_balance, 0) < COALESCE(ant_balance, 0)::bigint;
  END IF;
END $$;

-- Backward-compatible session bridge if old column exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'successful_sessions'
  ) THEN
    UPDATE users
    SET total_sessions = GREATEST(COALESCE(total_sessions, 0), COALESCE(successful_sessions, 0));
  END IF;
END $$;

-- Main repair rule: expected_ants = total_sessions * 4882812
UPDATE users
SET ants_balance = GREATEST(COALESCE(ants_balance, 0), COALESCE(total_sessions, 0)::bigint * 4882812::bigint),
    progress_percent = LEAST(100, (COALESCE(total_sessions, 0)::double precision / 1000.0) * 100.0),
    is_eligible = (COALESCE(total_sessions, 0) >= 1000);

-- Required indexes.
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_session_end_time ON users(session_end_time);
CREATE INDEX IF NOT EXISTS idx_users_notification_sent ON users(notification_sent);

-- Global stats table from production spec.
CREATE TABLE IF NOT EXISTS global_stats (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  total_ants_mined BIGINT DEFAULT 0 CHECK (total_ants_mined >= 0),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO global_stats (id, total_ants_mined)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Sync global_stats from existing network_stats.total_mined_ants when available.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_name = 'network_stats'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'network_stats' AND column_name = 'total_mined_ants'
    ) THEN
      UPDATE global_stats
      SET total_ants_mined = GREATEST(
        COALESCE(total_ants_mined, 0),
        COALESCE((SELECT MAX(total_mined_ants)::bigint FROM network_stats), 0)
      ),
      updated_at = NOW()
      WHERE id = 1;
    END IF;
  END IF;
END $$;

COMMIT;
