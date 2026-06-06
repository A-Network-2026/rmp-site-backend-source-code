BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_validator_candidate BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS validator_status VARCHAR(50) DEFAULT 'MINER';
ALTER TABLE users ADD COLUMN IF NOT EXISTS validator_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS validator_joined_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS validator_reputation INTEGER DEFAULT 0;

-- Normalize existing rows if columns were added without defaults in earlier environments.
UPDATE users
SET is_validator_candidate = COALESCE(is_validator_candidate, FALSE),
    validator_status = COALESCE(NULLIF(validator_status, ''), 'MINER'),
    validator_reputation = COALESCE(validator_reputation, 0)
WHERE is_validator_candidate IS NULL
   OR validator_status IS NULL
   OR validator_status = ''
   OR validator_reputation IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_validator_status ON users(validator_status);

COMMIT;
