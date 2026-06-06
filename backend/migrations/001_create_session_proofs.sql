-- Emergency migration: Create session_proofs table if not exists
-- This table was missing in production, causing 500 errors on mining/status endpoint

CREATE TABLE IF NOT EXISTS session_proofs (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT UNIQUE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  wallet_address TEXT,
  migration_wallet TEXT,
  challenge_hash TEXT,
  challenge_seed TEXT,
  challenge_block_hash TEXT,
  challenge_timestamp TIMESTAMP,
  proof_hash TEXT,
  validator_signature TEXT,
  nonce TEXT,
  heartbeat_count INTEGER DEFAULT 0,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  proof_status VARCHAR(50) DEFAULT 'pending',
  proof_verified_at TIMESTAMP,
  is_verified BOOLEAN DEFAULT FALSE,
  included_in_block BOOLEAN DEFAULT FALSE,
  block_height BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_session_proofs_user_time ON session_proofs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_proofs_status ON session_proofs(proof_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_proofs_session_id ON session_proofs(session_id);

-- Ensure network_stats has proper indexes for the hot query
CREATE INDEX IF NOT EXISTS idx_network_stats_mining_active ON network_stats(is_mining_active) WHERE is_mining_active = TRUE;

-- Add index to mining_sessions for faster queries on the most common filter
CREATE INDEX IF NOT EXISTS idx_mining_sessions_user_completed_time ON mining_sessions(user_id, is_completed, start_time DESC);
