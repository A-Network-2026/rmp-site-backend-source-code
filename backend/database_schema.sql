/**
 * ⛏️ A-NETWORK CRYPTO MINING DATABASE SCHEMA
 * PostgreSQL initialization script
 */

--- Drop existing tables if they exist
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS network_stats CASCADE;
DROP TABLE IF EXISTS mining_sessions CASCADE;

--- ========================
--- 👥 USERS TABLE
--- ========================
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  device_id VARCHAR(255),
  device_fingerprint TEXT,
  
  uuid VARCHAR(255) UNIQUE,

  --- 🪙 Balance tracking
  balance DECIMAL(20, 8) DEFAULT 0,
  ant_balance DECIMAL(20, 8) DEFAULT 0,
  successful_sessions BIGINT DEFAULT 0,
  
  --- ⛏️ Mining status
  is_mining BOOLEAN DEFAULT FALSE,
  last_mining_start TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  --- 📍 Location & Network
  last_ip VARCHAR(255),
  country VARCHAR(80) DEFAULT 'Unknown',

  --- 🔐 Anti-abuse risk controls
  risk_score INT DEFAULT 0,
  is_flagged BOOLEAN DEFAULT FALSE,
  flag_reason TEXT,
  last_risk_at TIMESTAMP,
  
  --- 💼 Wallet System
  --- Custom ANET wallet (starts with ANET)
  custom_wallet_address VARCHAR(255) UNIQUE,
  wallet_address VARCHAR(42) UNIQUE,
  wallet_passphrase TEXT,
  wallet_seed_encrypted TEXT,
  wallet_seed_iv TEXT,
  wallet_seed_tag TEXT,
  -- PIN-keyed encryption: AES-256-GCM with PBKDF2(PIN, sha256(userId), 100k) key.
  -- Primary decrypt path; server-key columns above serve as PIN-reset recovery only.
  wallet_seed_pin_encrypted TEXT,
  wallet_seed_pin_iv TEXT,
  wallet_seed_pin_tag TEXT,
  pin_hash TEXT,
  pin_enabled BOOLEAN DEFAULT FALSE,
  seed_view_otp_hash TEXT,
  seed_view_otp_expiry TIMESTAMP,
  seed_view_otp_attempts INT DEFAULT 0,
  pin_reset_otp_hash TEXT,
  pin_reset_otp_expiry TIMESTAMP,
  pin_reset_otp_attempts INT DEFAULT 0,
  evm_connected_address VARCHAR(42),
  
  --- 👥 Referral
  referral_code VARCHAR(32),
  referred_by BIGINT,
  referral_first_session_rewarded BOOLEAN DEFAULT FALSE,
  
  --- 🗑️ Soft delete for inactivity
  is_deleted BOOLEAN DEFAULT FALSE,
  deleted_at TIMESTAMP,
  deletion_requested_at TIMESTAMP,
  deletion_scheduled_for TIMESTAMP,
  deletion_restore_used BOOLEAN DEFAULT FALSE,
  deletion_restored_at TIMESTAMP,

  --- 🚫 Ban system
  is_banned BOOLEAN DEFAULT FALSE,
  banned_at TIMESTAMP,
  ban_reason TEXT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_email ON users(email);
CREATE INDEX idx_is_mining ON users(is_mining);
CREATE INDEX idx_balance ON users(balance DESC);
CREATE INDEX idx_last_activity ON users(last_activity_at DESC);
CREATE INDEX idx_is_deleted ON users(is_deleted);
CREATE INDEX idx_custom_wallet ON users(custom_wallet_address);
CREATE INDEX idx_device_id ON users(device_id);
CREATE INDEX idx_device_fingerprint ON users(device_fingerprint);
CREATE INDEX idx_last_ip ON users(last_ip);
CREATE INDEX idx_risk_score ON users(risk_score);
CREATE UNIQUE INDEX idx_users_referral_code_unique ON users(referral_code) WHERE referral_code IS NOT NULL;

--- ========================
--- 🌐 NETWORK STATS TABLE
--- ========================
CREATE TABLE network_stats (
  id BIGSERIAL PRIMARY KEY,
  
  total_users BIGINT DEFAULT 0,
  eligible_users BIGINT DEFAULT 0,
  total_sessions BIGINT DEFAULT 0,
  halving_count BIGINT DEFAULT 0,
  
  total_mined DECIMAL(20, 8) DEFAULT 0,
  is_mining_active BOOLEAN DEFAULT TRUE,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

--- Initialize network stats (only one row)
INSERT INTO network_stats (total_users, eligible_users, halving_count, total_mined, is_mining_active)
VALUES (0, 0, 0, 0, TRUE);

--- ========================
--- ⛏️ MINING SESSIONS TABLE
--- ========================
CREATE TABLE mining_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  
  reward DECIMAL(20, 8) DEFAULT 0,
  halving_level BIGINT DEFAULT 0,
  last_heartbeat TIMESTAMP,
  heartbeat_count INT DEFAULT 0,
  is_flagged BOOLEAN DEFAULT FALSE,
  started_ip VARCHAR(255),
  completed_ip VARCHAR(255),
  
  is_completed BOOLEAN DEFAULT FALSE,
  status VARCHAR(255) DEFAULT 'active',
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_mining ON mining_sessions(user_id);
CREATE INDEX idx_completed ON mining_sessions(is_completed);
CREATE INDEX idx_start_time ON mining_sessions(start_time DESC);
CREATE INDEX idx_session_heartbeat ON mining_sessions(last_heartbeat);
CREATE INDEX idx_mining_sessions_active_user_time ON mining_sessions(user_id, start_time DESC) WHERE is_completed = FALSE;
CREATE INDEX idx_mining_sessions_completed_user_time ON mining_sessions(user_id, start_time DESC) WHERE is_completed = TRUE AND COALESCE(status, '') = 'completed';
CREATE INDEX idx_mining_sessions_overdue_start_user ON mining_sessions(start_time DESC, user_id) WHERE is_completed = FALSE;

--- ========================
--- 🛡️ SECURITY AUDIT LOGS
--- ========================
CREATE TABLE security_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  user_id BIGINT,
  session_id BIGINT,
  ip VARCHAR(255),
  device_id VARCHAR(255),
  device_fingerprint TEXT,
  risk_points INT DEFAULT 0,
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_security_audit_user ON security_audit_logs(user_id);
CREATE INDEX idx_security_audit_event ON security_audit_logs(event_type);
CREATE INDEX idx_security_audit_time ON security_audit_logs(created_at DESC);

--- ========================
--- 🏦 ANT TOKEN TRANSACTIONS TABLE
--- ========================
CREATE TABLE ant_transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  
  --- Transaction types: mining_reward, ecosystem_return, evm_bridge, referral_bonus
  transaction_type VARCHAR(50) NOT NULL,
  amount DECIMAL(20, 8) NOT NULL,
  
  from_address VARCHAR(255),
  to_address VARCHAR(255),
  
  description TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_transactions ON ant_transactions(user_id);
CREATE INDEX idx_transaction_type ON ant_transactions(transaction_type);
CREATE INDEX idx_transaction_status ON ant_transactions(status);

--- ========================
--- 💬 REFERRAL COMMUNITY CHAT
--- ========================
CREATE TABLE referral_chat_rooms (
  room_key VARCHAR(32) PRIMARY KEY,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_name VARCHAR(80) NOT NULL DEFAULT 'Worker Ants',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_referral_chat_rooms_owner
ON referral_chat_rooms(owner_user_id);

CREATE TABLE referral_group_messages (
  id BIGSERIAL PRIMARY KEY,
  room_key VARCHAR(32) NOT NULL DEFAULT 'qualified-referrals',
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_text VARCHAR(500) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_referral_group_messages_room_time
ON referral_group_messages(room_key, created_at DESC);

--- ========================
--- 🏆 COLONY REWARD CYCLES
--- ========================
CREATE TABLE colony_reward_cycles (
  id BIGSERIAL PRIMARY KEY,
  cycle_key VARCHAR(7) NOT NULL UNIQUE,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  reward_pool_usdt DECIMAL(20, 8) NOT NULL DEFAULT 1000,
  base_rate DECIMAL(20, 8) NOT NULL DEFAULT 0.0015,
  network_active_users BIGINT NOT NULL DEFAULT 0,
  total_network_cp DECIMAL(30, 8) NOT NULL DEFAULT 0,
  total_colonies BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  formula_version VARCHAR(32) NOT NULL DEFAULT 'f1-v1',
  snapshot_taken_at TIMESTAMP,
  finalized_at TIMESTAMP,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_colony_reward_cycles_status
ON colony_reward_cycles(status);

CREATE INDEX idx_colony_reward_cycles_period_start
ON colony_reward_cycles(period_start DESC);

--- ========================
--- 💸 COLONY REWARD ALLOCATIONS
--- ========================
CREATE TABLE colony_reward_allocations (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES colony_reward_cycles(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  colony_label VARCHAR(255),
  invite_code VARCHAR(32),
  total_members INT NOT NULL DEFAULT 0,
  verified_members INT NOT NULL DEFAULT 0,
  active_members INT NOT NULL DEFAULT 0,
  community_participants INT NOT NULL DEFAULT 0,
  total_messages BIGINT NOT NULL DEFAULT 0,
  activity_rate DECIMAL(20, 8) NOT NULL DEFAULT 0,
  colony_strength DECIMAL(20, 8) NOT NULL DEFAULT 1,
  base_rate DECIMAL(20, 8) NOT NULL DEFAULT 0.0015,
  tier_name VARCHAR(32) NOT NULL DEFAULT 'Tier 1',
  tier_multiplier DECIMAL(20, 8) NOT NULL DEFAULT 1,
  base_cp DECIMAL(30, 8) NOT NULL DEFAULT 0,
  final_cp DECIMAL(30, 8) NOT NULL DEFAULT 0,
  reward_usdt DECIMAL(20, 8) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'finalized',
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (cycle_id, owner_user_id)
);

CREATE INDEX idx_colony_reward_allocations_cycle
ON colony_reward_allocations(cycle_id);

CREATE INDEX idx_colony_reward_allocations_owner
ON colony_reward_allocations(owner_user_id);

--- ========================
--- ⛓️ COLONY TRANSPARENCY ANCHORS
--- ========================
CREATE TABLE colony_reward_transparency_anchors (
  id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES colony_reward_cycles(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank_position INT NOT NULL,
  colony_label VARCHAR(255) NOT NULL,
  top_owner_label VARCHAR(255) NOT NULL DEFAULT '',
  invite_code VARCHAR(32),
  active_members INT NOT NULL DEFAULT 0,
  anet_transaction_id VARCHAR(128) NOT NULL,
  memo VARCHAR(160) NOT NULL,
  publish_status VARCHAR(32) NOT NULL DEFAULT 'accepted',
  published_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (cycle_id, rank_position)
);

CREATE INDEX idx_colony_reward_transparency_cycle
ON colony_reward_transparency_anchors(cycle_id, rank_position ASC);

--- ========================
--- 🔐 FUNCTIONS & TRIGGERS
--- ========================

--- Update updated_at timestamp on users table
CREATE OR REPLACE FUNCTION update_users_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_timestamp_trigger
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_users_timestamp();

--- Update updated_at timestamp on network_stats table
CREATE OR REPLACE FUNCTION update_network_stats_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER network_stats_timestamp_trigger
BEFORE UPDATE ON network_stats
FOR EACH ROW
EXECUTE FUNCTION update_network_stats_timestamp();

--- ========================
--- 💾 SAMPLE DATA (OPTIONAL)
--- ========================

--- You can add test users like this:
--- INSERT INTO users (email, password, device_id, balance, successful_sessions)
--- VALUES ('test@example.com', '$2a$10$...', 'device_123', 50.5, 10);

--- That's it! The database is now ready for the A-Network mining app.
