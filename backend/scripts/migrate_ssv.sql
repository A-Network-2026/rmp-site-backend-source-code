-- AdMob SSV: create de-duplication table and add ai_token_balance column.
-- Run once on production DB before deploying adsSsv.js route.
-- Safe to re-run (uses IF NOT EXISTS / IF NOT EXISTS guards).

-- ── 1. SSV transaction log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ssv_transactions (
  id               BIGSERIAL PRIMARY KEY,
  transaction_id   VARCHAR(512) UNIQUE NOT NULL,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_unit_id       VARCHAR(256),
  reward_amount    INT NOT NULL DEFAULT 8,
  reward_item      VARCHAR(64) NOT NULL DEFAULT 'AI_TOKEN',
  received_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ssv_transactions_user_id
  ON ssv_transactions (user_id);

CREATE INDEX IF NOT EXISTS idx_ssv_transactions_received_at
  ON ssv_transactions (received_at DESC);

-- ── 2. Per-user AI token balance (server-authoritative) ─────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ai_token_balance INT NOT NULL DEFAULT 20;
