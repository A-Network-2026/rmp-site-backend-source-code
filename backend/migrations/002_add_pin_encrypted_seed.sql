-- Migration 002: PIN-keyed seed encryption columns
-- Seeds encrypted with the user's PIN-derived key (PBKDF2 + AES-256-GCM).
-- These columns supplement (not replace) the server-key encrypted columns,
-- which remain as the recovery path for PIN-reset flows.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_seed_pin_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS wallet_seed_pin_iv        TEXT,
  ADD COLUMN IF NOT EXISTS wallet_seed_pin_tag       TEXT;
