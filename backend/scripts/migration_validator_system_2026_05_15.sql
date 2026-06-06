-- ══════════════════════════════════════════════════════════════════════
-- A Network — Automated Validator Eligibility System
-- Migration: validator_system_2026_05_15
-- Run ONCE on production DB before deploying validator routes.
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

-- ── validator_profiles ────────────────────────────────────────────────
-- One row per user who has ever been evaluated for validator eligibility.
-- status: INELIGIBLE | ELIGIBLE | ACTIVE | SUSPENDED
CREATE TABLE IF NOT EXISTS validator_profiles (
  id                      SERIAL        PRIMARY KEY,
  user_id                 INTEGER       NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  status                  VARCHAR(20)   NOT NULL DEFAULT 'INELIGIBLE',
  activated_at            TIMESTAMP,
  suspended_at            TIMESTAMP,
  suspension_reason       TEXT,
  last_active_at          TIMESTAMP,
  cooldown_until          TIMESTAMP,
  total_validations       INTEGER       NOT NULL DEFAULT 0,
  successful_validations  INTEGER       NOT NULL DEFAULT 0,
  failed_validations      INTEGER       NOT NULL DEFAULT 0,
  reputation_score        NUMERIC(12,4) NOT NULL DEFAULT 0,
  streak_count            INTEGER       NOT NULL DEFAULT 0,
  created_at              TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- ── validator_tasks ───────────────────────────────────────────────────
-- One row per (validator, mining_session) assignment.
-- status: PENDING | COMPLETED | EXPIRED | SKIPPED
-- result: VALID   | INVALID   | ABSTAIN
CREATE TABLE IF NOT EXISTS validator_tasks (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_session_id BIGINT      NOT NULL,
  validator_user_id INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at       TIMESTAMP   NOT NULL DEFAULT NOW(),
  deadline_at       TIMESTAMP   NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  result            VARCHAR(20),
  submitted_at      TIMESTAMP,
  proof_hash        TEXT,
  created_at        TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- ── validation_logs ───────────────────────────────────────────────────
-- Immutable event ledger — never update/delete rows.
CREATE TABLE IF NOT EXISTS validation_logs (
  id                BIGSERIAL   PRIMARY KEY,
  event_type        VARCHAR(60) NOT NULL,
  validator_user_id INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  target_session_id BIGINT,
  task_id           UUID,
  metadata          JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- ── validator_rewards ─────────────────────────────────────────────────
-- Reward ledger: one row per reward event per task.
-- reward_type: VALIDATION_BASE | ACCURACY_BONUS | STREAK_BONUS
-- status:      PENDING | PAID | CANCELLED
CREATE TABLE IF NOT EXISTS validator_rewards (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id      UUID        REFERENCES validator_tasks(id) ON DELETE SET NULL,
  reward_type  VARCHAR(40) NOT NULL,
  amount_ants  BIGINT      NOT NULL DEFAULT 0,
  status       VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  paid_at      TIMESTAMP,
  created_at   TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- ── validator_reputation_history ──────────────────────────────────────
-- Append-only reputation change log.
CREATE TABLE IF NOT EXISTS validator_reputation_history (
  id            BIGSERIAL      PRIMARY KEY,
  user_id       INTEGER        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         NUMERIC(12,4)  NOT NULL,
  reason        VARCHAR(120),
  balance_after NUMERIC(12,4)  NOT NULL,
  created_at    TIMESTAMP      NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_validator_profiles_status
  ON validator_profiles(status);

CREATE INDEX IF NOT EXISTS idx_validator_profiles_last_active
  ON validator_profiles(last_active_at)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_validator_tasks_session
  ON validator_tasks(target_session_id);

CREATE INDEX IF NOT EXISTS idx_validator_tasks_user_pending
  ON validator_tasks(validator_user_id, status)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_validator_tasks_deadline_pending
  ON validator_tasks(deadline_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_validation_logs_user
  ON validation_logs(validator_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_validation_logs_session
  ON validation_logs(target_session_id);

CREATE INDEX IF NOT EXISTS idx_validator_rewards_user
  ON validator_rewards(user_id, status);

CREATE INDEX IF NOT EXISTS idx_validator_rep_history_user
  ON validator_reputation_history(user_id, created_at DESC);

COMMIT;
