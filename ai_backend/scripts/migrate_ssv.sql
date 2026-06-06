-- AdMob SSV migration for the Python AI backend.
-- Run once on production DB. Safe to re-run (uses IF NOT EXISTS guards).

-- ── 1. Add ai_token_balance to ai_user_profiles ─────────────────────────────
ALTER TABLE ai_user_profiles
  ADD COLUMN IF NOT EXISTS ai_token_balance INTEGER NOT NULL DEFAULT 20;

-- ── 2. SSV transaction de-duplication table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_ssv_transactions (
  id               BIGSERIAL PRIMARY KEY,
  transaction_id   VARCHAR(512) UNIQUE NOT NULL,
  user_profile_id  UUID NOT NULL REFERENCES ai_user_profiles(id) ON DELETE CASCADE,
  ad_unit_id       VARCHAR(256),
  reward_amount    INTEGER NOT NULL DEFAULT 8,
  reward_item      VARCHAR(64) NOT NULL DEFAULT 'AI_TOKEN',
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_ssv_transactions_profile
  ON ai_ssv_transactions (user_profile_id);
