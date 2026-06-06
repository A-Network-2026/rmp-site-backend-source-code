// mining routes v2 – riskEval scoped fix enforced
const crypto = require('crypto');
const db = require('../db');
const { addColumnIfMissing } = require('../utils/schemaGuard');
const verifyToken = require('../middleware/auth');
const { MAX_SESSIONS, ANTS_PER_SESSION, ANET_CONVERSION, SESSION_DURATION_HOURS, GRACE_PERIOD_HOURS } = require('../constants/economics');
const { t, normalizeLang } = require('../utils/i18n');
const { updateHalving } = require('../services/halving');
const {
  calculateRate,
  calculateRewardAnts,
  buildGlobalState,
  buildUserMiningState,
  HALVING_INTERVAL,
  MAX_SUPPLY_ANTS,
  MAX_HALVING_STAGE,
  MAX_SUPPLY,
  REQUIRED_SESSIONS_FOR_ELIGIBILITY,
  SESSIONS_PER_DAY,
  SESSION_HOURS,
  SESSION_SECONDS,
  anetToAnts,
  antsToAnet,
  safeConvert,
} = require('../services/miningEngine');
const {
  ensureAntiAbuseSchema,
  config: antiAbuseConfig,
  logAudit,
  addRisk,
  evaluateRisk,
  evaluateSecuritySignals,
} = require('../services/antiAbuse');
const {
  previewCleanup,
  applyCleanup,
  previewVerifiedReview,
} = require('../services/botCleanup');
const {
  buildValidatorCandidateState,
  createSessionChallenge,
  createSessionProof,
} = require('../services/sessionProofs');
const {
  checkAndSyncEligibility,
  assignValidationTasks,
} = require('../services/validatorEngine');

const ISSUANCE_ENDED_MESSAGE = 'ANET max supply reached. New issuance has ended. The network remains active, but mining rewards are no longer available.';
const RUN_MINING_SCHEMA_SYNC_STARTUP = String(process.env.RUN_MINING_SCHEMA_SYNC_STARTUP || 'false').trim().toLowerCase() === 'true';
const RUN_MINING_SESSION_RECONCILE_STARTUP = String(process.env.RUN_MINING_SESSION_RECONCILE_STARTUP || 'false').trim().toLowerCase() === 'true';
const RUN_MINING_TYPE_ALTER_STARTUP = String(process.env.RUN_MINING_TYPE_ALTER_STARTUP || 'false').trim().toLowerCase() === 'true';
const MINING_STARTUP_LOCK_KEY = Number(process.env.MINING_STARTUP_LOCK_KEY || 42133791);
const MINING_START_DEBOUNCE_MS = Math.max(1000, Number(process.env.MINING_START_DEBOUNCE_MS || 15000));
const OVERDUE_SWEEP_ENABLED = String(process.env.OVERDUE_MINING_SWEEP_ENABLED || 'true').trim().toLowerCase() !== 'false';
const OVERDUE_SWEEP_INTERVAL_MS = Math.max(15000, Number(process.env.OVERDUE_MINING_SWEEP_INTERVAL_MS || 60000));
const OVERDUE_SWEEP_BATCH_SIZE = Math.max(10, Number(process.env.OVERDUE_MINING_SWEEP_BATCH_SIZE || 150));
// Self-healing reconcile for successful_sessions/total_sessions drift. The two
// completion paths (finalizeMiningSession and /session/claim) can each write a
// 'completed' row while advancing the user counter only once, leaving a user
// slightly UNDERcounted. This periodic job raises an undercounted user's
// counter up to its true completed-row count. It is undercount-only: it never
// lowers a counter (legacy referral bonuses may legitimately inflate it) and
// never touches balances. Scoped to recently-active users to stay cheap.
const SESSION_COUNTER_RECONCILE_ENABLED = String(process.env.SESSION_COUNTER_RECONCILE_ENABLED || 'true').trim().toLowerCase() !== 'false';
const SESSION_COUNTER_RECONCILE_INTERVAL_MS = Math.max(60000, Number(process.env.SESSION_COUNTER_RECONCILE_INTERVAL_MS || 600000));
const SESSION_COUNTER_RECONCILE_LOOKBACK_HOURS = Math.max(1, Number(process.env.SESSION_COUNTER_RECONCILE_LOOKBACK_HOURS || 6));
const miningStatusCache = new Map();
const miningSessionsCache = new Map();
const networkStatsCache = new Map(); // Cache for hot network_stats query
const NETWORK_STATS_CACHE_TTL_MS = 5000; // 5 second TTL for network stats

function isDbConnectTimeoutError(err) {
  const code = String(err?.code || '');
  if (['ETIMEDOUT', 'ETIMEOUT', '53300', '53200', '53100'].includes(code)) {
    return true;
  }

  const message = String(err?.message || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
}

function isDbPressureHigh() {
  const waitingCount = Number(db.waitingCount || 0);
  const idleCount = Number(db.idleCount || 0);
  const totalCount = Number(db.totalCount || 0);

  if (!Number.isFinite(waitingCount) || waitingCount < MINING_DB_WAITING_THRESHOLD) {
    return false;
  }

  return idleCount <= 0 && totalCount > 0;
}

function getFreshCached(mapRef, key) {
  const cached = mapRef.get(String(key));
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    mapRef.delete(String(key));
    return null;
  }
  return cached.payload;
}

function setCached(mapRef, key, payload, ttlMs) {
  mapRef.set(String(key), {
    payload,
    expiresAt: Date.now() + ttlMs,
  });

  if (mapRef.size > 50000) {
    const oldestKey = mapRef.keys().next().value;
    if (oldestKey) {
      mapRef.delete(oldestKey);
    }
  }
}

const MINING_DB_WAITING_THRESHOLD = Math.max(3, Number(process.env.MINING_DB_WAITING_THRESHOLD || 14));
const MINING_STATUS_CACHE_MS = Math.max(1000, Number(process.env.MINING_STATUS_CACHE_MS || 5000));
const MINING_SESSIONS_CACHE_MS = Math.max(2000, Number(process.env.MINING_SESSIONS_CACHE_MS || 10000));

module.exports = async function (fastify) {
  async function ensureMiningSchema() {
    const client = await db.connect();
    const q = (...args) => client.query(...args);
    const runOptionalInSavepoint = async (sql, params = [], context = 'optional startup statement') => {
      await q('SAVEPOINT mining_startup_optional_sp');
      try {
        await q(sql, params);
        await q('RELEASE SAVEPOINT mining_startup_optional_sp');
      } catch (err) {
        try {
          await q('ROLLBACK TO SAVEPOINT mining_startup_optional_sp');
          await q('RELEASE SAVEPOINT mining_startup_optional_sp');
        } catch (_) {
          // Ignore savepoint cleanup failures; outer transaction handler will rollback if needed.
        }
        fastify.log.warn({ err, context }, 'Mining startup optional statement skipped');
      }
    };

    try {
      await q('BEGIN');
      const lockRes = await q('SELECT pg_try_advisory_xact_lock($1) AS locked', [MINING_STARTUP_LOCK_KEY]);
      if (!lockRes.rows[0] || !lockRes.rows[0].locked) {
        await q('ROLLBACK');
        fastify.log.info('Mining startup schema sync skipped (advisory lock held by another process)');
        return;
      }

      const schemaLogger = fastify && fastify.log ? fastify.log : null;
      await addColumnIfMissing('users', 'ant_balance', 'NUMERIC(30,0) DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('users', 'balance', 'NUMERIC(20,8) DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('users', 'claimed_anet', 'NUMERIC(20,8) DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('users', 'suspicious_flags', 'INT DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('users', 'suspicious_reason', 'TEXT', { logger: schemaLogger });
      await addColumnIfMissing('users', 'email_verified', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'referred_by', 'INT', { logger: schemaLogger });
      await addColumnIfMissing('users', 'referral_first_session_rewarded', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'device_id', 'VARCHAR(255)', { logger: schemaLogger });
      await addColumnIfMissing('users', 'wallet_address', 'VARCHAR(120)', { logger: schemaLogger });
      await addColumnIfMissing('users', 'is_mining', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'last_mining_start', 'TIMESTAMP', { logger: schemaLogger });
      await addColumnIfMissing('users', 'last_ip', 'VARCHAR(255)', { logger: schemaLogger });
      await addColumnIfMissing('users', 'total_sessions', 'BIGINT DEFAULT 0 CHECK (total_sessions >= 0)', { logger: schemaLogger });
      await addColumnIfMissing('users', 'progress_percent', 'DOUBLE PRECISION DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100)', { logger: schemaLogger });
      await addColumnIfMissing('users', 'last_session_time', 'TIMESTAMP NULL', { logger: schemaLogger });
      await addColumnIfMissing('users', 'session_end_time', 'TIMESTAMP NULL', { logger: schemaLogger });
      await addColumnIfMissing('users', 'notification_sent', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'ants_balance', 'BIGINT DEFAULT 0 CHECK (ants_balance >= 0)', { logger: schemaLogger });
      await addColumnIfMissing('users', 'is_eligible', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'preferred_language', "TEXT DEFAULT 'en' NOT NULL", { logger: schemaLogger });
      await addColumnIfMissing('users', 'is_banned', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'banned_at', 'TIMESTAMP', { logger: schemaLogger });
      await addColumnIfMissing('users', 'ban_reason', 'TEXT', { logger: schemaLogger });
      await addColumnIfMissing('users', 'is_validator_candidate', 'BOOLEAN DEFAULT FALSE', { logger: schemaLogger });
      await addColumnIfMissing('users', 'validator_status', "VARCHAR(50) DEFAULT 'MINER'", { logger: schemaLogger });
      await addColumnIfMissing('users', 'validator_key', 'TEXT', { logger: schemaLogger });
      await addColumnIfMissing('users', 'validator_joined_at', 'TIMESTAMP', { logger: schemaLogger });
      await addColumnIfMissing('users', 'validator_reputation', 'INTEGER DEFAULT 0', { logger: schemaLogger });

      await addColumnIfMissing('network_stats', 'total_users', 'BIGINT DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'eligible_users', 'BIGINT DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'total_sessions', 'BIGINT DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'halving_count', 'BIGINT DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'total_mined', 'NUMERIC(20,8) DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'total_mined_ants', 'NUMERIC(30,0) DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'total_anet_distributed', 'NUMERIC(20,8) DEFAULT 0', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'is_mining_active', 'BOOLEAN DEFAULT TRUE', { logger: schemaLogger });
      await addColumnIfMissing('network_stats', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP', { logger: schemaLogger });

      await q(`
      CREATE TABLE IF NOT EXISTS mining_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        reward DECIMAL(20, 8) DEFAULT 0,
        halving_level BIGINT DEFAULT 0,
        is_completed BOOLEAN DEFAULT FALSE,
        status VARCHAR(255) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
      `);

      await q(`
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
      )
      `);

      await q(`
      CREATE TABLE IF NOT EXISTS ant_transactions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        transaction_type VARCHAR(50) NOT NULL,
        amount DECIMAL(20, 8) NOT NULL,
        from_address VARCHAR(255),
        to_address VARCHAR(255),
        description TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
      `);

      await q('CREATE INDEX IF NOT EXISTS idx_user_transactions ON ant_transactions(user_id)');
      await q('CREATE INDEX IF NOT EXISTS idx_transaction_type ON ant_transactions(transaction_type)');
      await q('CREATE INDEX IF NOT EXISTS idx_transaction_status ON ant_transactions(status)');

    // These ALTER TABLE migrations are one-time. Wrap each in try-catch so that
    // if the column is already BIGINT (subsequent deploys) they skip harmlessly
    // and do not cause a deadlock with other startup queries.
    const alterStatements = [
      'ALTER TABLE users ALTER COLUMN id TYPE BIGINT',
      'ALTER TABLE users ALTER COLUMN referred_by TYPE BIGINT',
      'ALTER TABLE users ALTER COLUMN successful_sessions TYPE BIGINT',
      'ALTER TABLE users ALTER COLUMN total_sessions TYPE BIGINT',
      'ALTER TABLE network_stats ALTER COLUMN total_users TYPE BIGINT',
      'ALTER TABLE network_stats ALTER COLUMN eligible_users TYPE BIGINT',
      'ALTER TABLE network_stats ALTER COLUMN total_sessions TYPE BIGINT',
      'ALTER TABLE network_stats ALTER COLUMN halving_count TYPE BIGINT',
      'ALTER TABLE mining_sessions ALTER COLUMN id TYPE BIGINT',
      'ALTER TABLE mining_sessions ALTER COLUMN user_id TYPE BIGINT',
      'ALTER TABLE mining_sessions ALTER COLUMN halving_level TYPE BIGINT',
    ];
      if (RUN_MINING_TYPE_ALTER_STARTUP) {
        for (const sql of alterStatements) {
          await runOptionalInSavepoint(sql, [], sql);
        }
      } else {
        fastify.log.info('Mining startup type-alter migrations skipped (RUN_MINING_TYPE_ALTER_STARTUP=false)');
      }

      await q('CREATE INDEX IF NOT EXISTS idx_users_successful_sessions ON users(successful_sessions)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_is_mining ON users(is_mining)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_claimed_anet ON users(claimed_anet)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_session_end_time ON users(session_end_time)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_notification_sent ON users(notification_sent)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_validator_status ON users(validator_status)');
      await q('CREATE INDEX IF NOT EXISTS idx_users_not_mining_id ON users(id) WHERE is_mining = FALSE');
      await q('CREATE INDEX IF NOT EXISTS idx_mining_sessions_user_start_time ON mining_sessions(user_id, start_time DESC)');
      await q('CREATE INDEX IF NOT EXISTS idx_mining_sessions_user_completion ON mining_sessions(user_id, is_completed, start_time DESC)');
      await q('CREATE INDEX IF NOT EXISTS idx_session_proofs_user_time ON session_proofs(user_id, created_at DESC)');
      await q('CREATE INDEX IF NOT EXISTS idx_session_proofs_status ON session_proofs(proof_status, created_at DESC)');
      await q(`
        CREATE INDEX IF NOT EXISTS idx_mining_sessions_completed_user_id
        ON mining_sessions(user_id)
        WHERE is_completed = TRUE AND (status IS NULL OR status = 'completed')
      `);
      await q(`
        CREATE INDEX IF NOT EXISTS idx_users_effective_ant_balance
        ON users ((GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0))), id)
      `);
      await q('CREATE INDEX IF NOT EXISTS idx_users_wallet_address_upper ON users (UPPER(wallet_address))');

      // Performance: presence touch UPDATE (auth middleware) - last_seen_at stale partial index
      await q(`
        CREATE INDEX IF NOT EXISTS idx_users_last_seen_stale
        ON users (id, last_seen_at)
        WHERE last_seen_at IS NULL
      `);
      // Performance: recently-active users lookup (stats /network users_online)
      await q(`
        CREATE INDEX IF NOT EXISTS idx_users_recently_seen
        ON users (last_seen_at DESC)
        WHERE last_seen_at IS NOT NULL
      `);
      // Performance: orphan sweep CTE scan - is_completed=FALSE + start_time ordered
      await q(`
        CREATE INDEX IF NOT EXISTS idx_mining_sessions_orphan_sweep
        ON mining_sessions (start_time ASC, user_id)
        WHERE is_completed = FALSE
      `);
      // Performance: country stats GROUP BY country for active users
      await q(`
        CREATE INDEX IF NOT EXISTS idx_users_country_active
        ON users (country)
        WHERE is_deleted = FALSE OR is_deleted IS NULL
      `);

      if (RUN_MINING_SESSION_RECONCILE_STARTUP) {
        await runOptionalInSavepoint(`
        WITH completed AS (
          SELECT user_id, COUNT(*)::bigint AS completed_sessions
          FROM mining_sessions
          WHERE is_completed = TRUE
            AND (status IS NULL OR status = 'completed')
          GROUP BY user_id
        )
        UPDATE users u
        SET successful_sessions = COALESCE(completed.completed_sessions, 0),
            total_sessions = COALESCE(completed.completed_sessions, 0),
            ants_balance = GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint),
            progress_percent = LEAST(
              100,
              (COALESCE(completed.completed_sessions, 0)::double precision / 1000.0) * 100.0
            ),
            is_eligible = (COALESCE(completed.completed_sessions, 0) >= 1000)
        FROM completed
        WHERE completed.user_id = u.id
      `, [], 'startup session reconciliation');
      }

      await q(`
      INSERT INTO network_stats (id, total_users, eligible_users, total_sessions, halving_count, total_mined, total_mined_ants, total_anet_distributed, is_mining_active)
      VALUES (1, 0, 0, 0, 0, 0, 0, 0, TRUE)
      ON CONFLICT (id) DO NOTHING
      `);

      await q('COMMIT');
    } catch (err) {
      try { await q('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function flagSuspicious(userId, reason) {
    if (!userId) return;
    await db.query(
      `UPDATE users
       SET suspicious_flags = COALESCE(suspicious_flags, 0) + 1,
           suspicious_reason = $2
       WHERE id = $1`,
      [userId, reason]
    );
  }

  async function isAdmin(userId) {
    const adminIds = String(process.env.ADMIN_USER_IDS || '1')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
    return adminIds.includes(Number(userId));
  }

  async function finalizeMiningSession({ userId, ip, req, autoTriggered = false }) {
    const userRes = await db.readQuery(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    const user = userRes.rows[0];

    if (!user) {
      return { error: 'User not found' };
    }

    if (user.is_banned) {
      return { error: 'Your account has been suspended. Contact support.' };
    }

    // Email verification and is_mining flag are only enforced for user-triggered completions.
    // The sweeper works directly off the mining_sessions table and must not be gated
    // by stale user flags that may have been cleared after a session started.
    if (!autoTriggered) {
      if (!user.email_verified) {
        await flagSuspicious(userId, 'attempt_complete_without_email_verification');
        return { error: 'Email not verified. Verify OTP before mining actions.' };
      }

      if (!user.is_mining || !user.last_mining_start) {
        return { error: 'No active mining session' };
      }
    }

    const activeSessionRes = await db.query(
      `SELECT id, start_time, last_heartbeat, heartbeat_count
       FROM mining_sessions
       WHERE user_id = $1 AND is_completed = FALSE
       ORDER BY start_time DESC
       LIMIT 1`,
      [userId]
    );
    const activeSession = activeSessionRes.rows[0];
    if (!activeSession) {
      if (!autoTriggered) {
        await flagSuspicious(userId, 'attempt_complete_without_active_session');
      }
      return { error: 'No active mining session' };
    }

    // Heartbeat validation is disabled — all sessions complete with full reward
    // regardless of heartbeat count or gap. Users who background/close the app
    // mid-session are not penalised.

    // Use cached network_stats to avoid hammering primary during completion spikes
    let stats = null;
    const cachedStats = networkStatsCache.get('current');
    if (cachedStats && cachedStats.expiresAt > Date.now()) {
      stats = cachedStats.data;
    } else {
      const netRes = await db.readQuery(`SELECT * FROM network_stats LIMIT 1`);
      stats = netRes.rows[0];
      networkStatsCache.set('current', {
        data: stats,
        expiresAt: Date.now() + NETWORK_STATS_CACHE_TTL_MS,
      });
    }

    const proofSeedRes = await db.readQuery(
      `SELECT * FROM session_proofs WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
      [activeSession.id]
    );
    const existingProof = proofSeedRes.rows[0] || null;

    const now = new Date();
    const diffHours =
      (now - new Date(activeSession.start_time)) / (1000 * 60 * 60);

    if (diffHours < 6) {
      await flagSuspicious(userId, 'attempt_early_completion');
      return { error: 'Mining not complete' };
    }

    const proofChallengeBootstrap = existingProof || await createSessionChallenge({
      wallet: user.wallet_address,
      migrationWallet: user.migration_wallet_address,
    });
    const proofNonce = proofChallengeBootstrap.nonce || crypto.randomBytes(16).toString('hex');
    const proofChallengeHash = proofChallengeBootstrap.challenge_hash || proofChallengeBootstrap.challengeHash;
    const proofChallengeTimestamp = proofChallengeBootstrap.challenge_timestamp || proofChallengeBootstrap.challengeTimestamp || new Date(activeSession.start_time || now).toISOString();
    const proofChallengeBlockHash = proofChallengeBootstrap.challenge_block_hash || proofChallengeBootstrap.currentBlockHash || 'GENESIS';
    const { proofHash, validatorSignature } = createSessionProof({
      sessionId: activeSession.id,
      challengeHash: proofChallengeHash,
      startTime: activeSession.start_time,
      endTime: now,
      wallet: user.wallet_address,
      heartbeatCount: activeSession.heartbeat_count || 0,
      nonce: proofNonce,
    });

    let auditRiskPoints = 0;
    let auditRiskReasons = [];

    // Sweeper is server-trusted — skip all risk/security checks to avoid
    // accumulating false risk scores on users and to ensure sessions are credited.
    if (!autoTriggered) {
      const riskEval = await evaluateRisk(db, {
        userId,
        ip,
        deviceId: user.device_id,
        deviceFingerprint: user.device_fingerprint,
      });
      const securityEval = evaluateSecuritySignals(req, {
        deviceFingerprint: user.device_fingerprint,
      });
      const cfg = antiAbuseConfig();
      const combinedRisk = riskEval.risk + securityEval.risk;
      const combinedReasons = [...riskEval.reasons, ...securityEval.reasons];
      auditRiskPoints = combinedRisk;
      auditRiskReasons = combinedReasons;
      if (combinedRisk > 0) {
        await addRisk(db, userId, combinedRisk, combinedReasons.join(', '), {
          flag: combinedRisk >= cfg.riskBlockThreshold,
        });
      }
      if (securityEval.shouldBlock || combinedRisk >= cfg.riskBlockThreshold) {
        await db.query(
          `UPDATE mining_sessions
           SET status = 'blocked_high_risk',
               is_completed = TRUE,
               is_flagged = TRUE,
               end_time = NOW(),
               completed_ip = $2
           WHERE id = $1`,
          [activeSession.id, ip]
        );
        await db.query('UPDATE users SET is_mining = FALSE WHERE id = $1', [userId]);
        await logAudit(db, {
          eventType: 'mining_complete_blocked_risk',
          userId,
          sessionId: activeSession.id,
          ip,
          deviceId: user.device_id,
          deviceFingerprint: user.device_fingerprint,
          riskPoints: combinedRisk,
          details: { reasons: combinedReasons, trigger: 'complete' },
        });
        return { error: securityEval.blockReason || 'Mining completion blocked for security review' };
      }
    }

    if (!stats.is_mining_active) {
      await db.query(
        `UPDATE users
         SET is_mining = false
         WHERE id = $1`,
        [userId]
      );
      await db.query(
        `UPDATE mining_sessions
         SET end_time = NOW(),
             reward = 0,
             halving_level = COALESCE(halving_level, 0),
             is_completed = TRUE,
             status = 'network_inactive'
         WHERE id = $1`,
        [activeSession.id]
      );

      const latestUserRes = await db.query(
        `SELECT GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) AS effective_ant_balance
         FROM users
         WHERE id = $1`,
        [userId]
      );

      return {
        reward: 0,
        rewardAnts: 0,
        userBalance: antsToAnet(latestUserRes.rows[0]?.effective_ant_balance || 0),
        userBalanceAnts: Number(latestUserRes.rows[0]?.effective_ant_balance || 0),
        totalMined: antsToAnet(stats.total_mined_ants || 0),
        totalMinedAnts: Number(stats.total_mined_ants || 0),
        message: ISSUANCE_ENDED_MESSAGE,
        issuanceEnded: true,
        completedVia: autoTriggered ? 'status' : 'complete',
      };
    }

    if (Number(stats.total_mined_ants || 0) >= MAX_SUPPLY_ANTS) {
      await db.query(`
        UPDATE network_stats
        SET is_mining_active = FALSE
      `);

      await db.query(`
        UPDATE users
        SET is_mining = false
        WHERE id = $1
      `, [userId]);
      await db.query(
        `UPDATE mining_sessions
         SET end_time = NOW(),
             reward = 0,
             is_completed = TRUE,
             status = 'max_supply_reached'
         WHERE id = $1`,
        [activeSession.id]
      );

      const latestUserRes = await db.query(
        `SELECT GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) AS effective_ant_balance
         FROM users
         WHERE id = $1`,
        [userId]
      );

      return {
        reward: 0,
        rewardAnts: 0,
        userBalance: antsToAnet(latestUserRes.rows[0]?.effective_ant_balance || 0),
        userBalanceAnts: Number(latestUserRes.rows[0]?.effective_ant_balance || 0),
        totalMined: antsToAnet(stats.total_mined_ants || 0),
        totalMinedAnts: Number(stats.total_mined_ants || 0),
        message: ISSUANCE_ENDED_MESSAGE,
        issuanceEnded: true,
        completedVia: autoTriggered ? 'status' : 'complete',
      };
    }

    const pre = await updateHalving();
    const totalNetworkSessions = Number(pre.totalCompletedSessions || pre.totalSessions || 0);
    const halvingStage = Math.min(Number(pre.halvingStage || 0), MAX_HALVING_STAGE);

    const rewardPerSession = calculateRate(halvingStage, totalNetworkSessions);

    let rewardAnts = calculateRewardAnts(halvingStage, totalNetworkSessions);
    let reward = antsToAnet(rewardAnts);

    const totalMinedAnts = Number(stats.total_mined_ants || 0);
    if (totalMinedAnts + rewardAnts > MAX_SUPPLY_ANTS) {
      rewardAnts = MAX_SUPPLY_ANTS - totalMinedAnts;
      reward = antsToAnet(rewardAnts);

      await db.query(`
        UPDATE network_stats
        SET is_mining_active = FALSE
      `);
    }

    const client = await db.connect();
    let userUpdateRes;
    let networkUpdateRes;

    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT proof_upsert');
      try {
        await client.query(
          `INSERT INTO session_proofs (
            session_id,
            user_id,
            wallet_address,
            migration_wallet,
            challenge_hash,
            challenge_seed,
            challenge_block_hash,
            challenge_timestamp,
            proof_hash,
            validator_signature,
            nonce,
            heartbeat_count,
            start_time,
            end_time,
            proof_status,
            proof_verified_at,
            is_verified,
            included_in_block,
            block_height
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'verified',NOW(),TRUE,FALSE,NULL)
          ON CONFLICT (session_id) DO UPDATE SET
            wallet_address = EXCLUDED.wallet_address,
            migration_wallet = EXCLUDED.migration_wallet,
            challenge_hash = EXCLUDED.challenge_hash,
            challenge_seed = EXCLUDED.challenge_seed,
            challenge_block_hash = EXCLUDED.challenge_block_hash,
            challenge_timestamp = EXCLUDED.challenge_timestamp,
            proof_hash = EXCLUDED.proof_hash,
            validator_signature = EXCLUDED.validator_signature,
            nonce = EXCLUDED.nonce,
            heartbeat_count = EXCLUDED.heartbeat_count,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            proof_status = 'verified',
            proof_verified_at = NOW(),
            is_verified = TRUE,
            created_at = COALESCE(session_proofs.created_at, NOW())`,
          [
            activeSession.id,
            userId,
            user.wallet_address,
            user.migration_wallet_address || null,
            proofChallengeHash,
            proofChallengeBootstrap.challenge_seed || proofChallengeBootstrap.randomSeed || null,
            proofChallengeBlockHash,
            proofChallengeTimestamp,
            proofHash,
            validatorSignature,
            proofNonce,
            Number(activeSession.heartbeat_count || 0),
            activeSession.start_time,
            now,
          ]
        );
      } catch (proofErr) {
        await client.query('ROLLBACK TO SAVEPOINT proof_upsert');
        fastify.log.warn(
          {
            userId,
            sessionId: activeSession.id,
            err: proofErr?.message || proofErr,
          },
          'session_proofs upsert failed; continuing mining completion',
        );
      }

      // Gate completion on an uncompleted active row to prevent duplicate session increments.
      const sessionCompleteRes = await client.query(
        `UPDATE mining_sessions
         SET end_time = NOW(),
             reward = $1,
             halving_level = $2,
             is_completed = TRUE,
             status = 'completed',
             completed_ip = $4
         WHERE id = $3
           AND is_completed = FALSE
         RETURNING id`,
        [reward, halvingStage, activeSession.id, ip]
      );

      if (sessionCompleteRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return { error: 'Session already completed or invalid' };
      }

      userUpdateRes = await client.query(`
        UPDATE users
        SET ants_balance = GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) + $1,
            ant_balance = GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) + $1,
            total_sessions = COALESCE(total_sessions, 0) + 1,
            successful_sessions = COALESCE(total_sessions, 0) + 1,
            progress_percent = LEAST(
              100,
              ((COALESCE(total_sessions, 0) + 1)::double precision / 1000.0) * 100.0
            ),
            is_eligible = (COALESCE(total_sessions, 0) + 1) >= 1000,
            is_mining = false
        WHERE id = $2
        RETURNING GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) AS effective_ant_balance,
                  successful_sessions,
                  total_sessions,
                  email_verified,
                  wallet_address,
                  migration_wallet_address,
                  is_banned,
                  risk_score,
                  validator_status,
                  validator_reputation
      `, [rewardAnts, userId]);

      const validatorState = buildValidatorCandidateState({
        wallet: userUpdateRes.rows[0]?.wallet_address || user.wallet_address,
        migrationWallet: userUpdateRes.rows[0]?.migration_wallet_address || user.migration_wallet_address,
        emailVerified: Boolean(userUpdateRes.rows[0]?.email_verified ?? user.email_verified),
        isBanned: Boolean(userUpdateRes.rows[0]?.is_banned ?? user.is_banned),
        riskScore: Number(userUpdateRes.rows[0]?.risk_score ?? user.risk_score ?? 0),
        totalSessions: Number(userUpdateRes.rows[0]?.total_sessions || 0),
      });

      if (validatorState.isValidatorCandidate) {
        await client.query('SAVEPOINT validator_update');
        try {
          await client.query(
            `UPDATE users
             SET is_validator_candidate = TRUE,
                 validator_status = $2,
                 validator_joined_at = COALESCE(validator_joined_at, NOW()),
                 validator_key = COALESCE(validator_key, $3),
                 validator_reputation = COALESCE(validator_reputation, 0)
             WHERE id = $1`,
            [
              userId,
              validatorState.validatorStatus,
              validatorState.validatorKey,
            ]
          );
        } catch (validatorErr) {
          await client.query('ROLLBACK TO SAVEPOINT validator_update');
          if (validatorErr?.code !== '42703') {
            throw validatorErr;
          }
          fastify.log.warn(
            {
              userId,
              sessionId: activeSession.id,
              err: validatorErr?.message || validatorErr,
            },
            'validator update skipped due to schema mismatch; continuing mining completion',
          );
        }
      }

      networkUpdateRes = await client.query(`
        UPDATE network_stats
        SET total_mined_ants = COALESCE(total_mined_ants, 0) + $1,
            total_mined = ROUND((COALESCE(total_mined_ants, 0) + $1) / 100000000.0, 8)
        WHERE id = $2
        RETURNING total_mined, total_mined_ants
      `, [rewardAnts, stats.id]);

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
      throw err;
    } finally {
      client.release();
    }

    await logAudit(db, {
      eventType: autoTriggered ? 'mining_autocomplete' : 'mining_complete',
      userId,
      sessionId: activeSession.id,
      ip,
      deviceId: user.device_id,
      deviceFingerprint: user.device_fingerprint,
      riskPoints: auditRiskPoints,
      details: {
        reward,
        rewardAnts,
        reasons: auditRiskReasons,
        trigger: autoTriggered ? 'status' : 'complete',
      },
    });

    const updatedUserBalanceAnts = Number(userUpdateRes.rows[0]?.effective_ant_balance || 0);
    const updatedUserBalance = antsToAnet(updatedUserBalanceAnts);
    const updatedSessions = Number(userUpdateRes.rows[0]?.successful_sessions || 0);

    const updatedTotalMined = Number(networkUpdateRes.rows[0]?.total_mined || 0);
    const updatedTotalMinedAnts = Number(networkUpdateRes.rows[0]?.total_mined_ants || 0);
    const userState = buildUserMiningState({
      id: userId,
      successful_sessions: updatedSessions,
      ant_balance: updatedUserBalanceAnts,
      claimed_anet: user.claimed_anet,
    });

    await updateHalving();

    // Fire-and-forget: sync validator eligibility profile and assign tasks
    const _vsId  = activeSession.id;
    const _vuId  = userId;
    checkAndSyncEligibility(_vuId, db).catch((err) =>
      fastify.log.warn({ err: err.message, userId: _vuId }, 'validator eligibility sync failed')
    );
    assignValidationTasks(_vsId, _vuId, db).catch((err) =>
      fastify.log.warn({ err: err.message, sessionId: _vsId }, 'validator task assignment failed')
    );

    return {
      reward: Number(reward.toFixed(8)),
      rewardAnts,
      userBalance: updatedUserBalance,
      userBalanceAnts: updatedUserBalanceAnts,
      totalSessions: updatedSessions,
      isEligible: userState.isEligible,
      totalMined: updatedTotalMined,
      totalMinedAnts: updatedTotalMinedAnts,
      initialRewardPerSession: rewardPerSession,
      halvingStage,
      sessionDurationHours: SESSION_HOURS,
      cyclePerDay: SESSIONS_PER_DAY,
      referrerBonusGranted: false,
      user: userState,
      completedVia: autoTriggered ? 'status' : 'complete',
      message: totalMinedAnts + rewardAnts >= MAX_SUPPLY_ANTS
        ? 'Final mining completed. ANET max supply reached. New issuance has ended, and the network remains active.'
        : `Mining success | Halving Stage: ${halvingStage} | Reward: ${rewardAnts} ANTS (${Number(reward.toFixed(8))} ANET)`
    };
  }

  function buildSystemSweepRequest(user) {
    return {
      ip: '127.0.0.1',
      headers: {
        'x-app-runtime': 'debug',
        'x-device-id': String(user?.device_id || ''),
        'x-device-fingerprint': String(user?.device_fingerprint || ''),
      },
      body: {
        deviceId: String(user?.device_id || ''),
        deviceFingerprint: String(user?.device_fingerprint || ''),
      },
    };
  }

  async function sweepOverdueActiveSessions() {
    const overdueRes = await db.query(
      `SELECT DISTINCT ON (u.id)
          u.id AS user_id,
          u.device_id,
          u.device_fingerprint
       FROM users u
       JOIN mining_sessions ms ON ms.user_id = u.id
       WHERE ms.is_completed = FALSE
         AND ms.start_time <= NOW() - $1 * INTERVAL '1 hour'
         AND COALESCE(u.is_mining, FALSE) = TRUE
       ORDER BY u.id, ms.start_time DESC
       LIMIT $2`,
      [SESSION_DURATION_HOURS, OVERDUE_SWEEP_BATCH_SIZE]
    );

    let completed = 0;
    let blocked = 0;
    let failed = 0;

    for (const row of overdueRes.rows) {
      try {
        const req = buildSystemSweepRequest(row);
        const result = await finalizeMiningSession({
          userId: Number(row.user_id),
          ip: req.ip,
          req,
          autoTriggered: true,
        });
        if (result?.error) {
          blocked += 1;
        } else {
          completed += 1;
        }
      } catch (_) {
        failed += 1;
      }
    }

    // Close orphan active rows that are far beyond the valid claim window and
    // already detached from an active user mining state.
    // SKIP LOCKED prevents multi-pod contention on the same rows.
    const orphanCloseRes = await db.query(
      `WITH stale AS (
         SELECT ms.id
         FROM mining_sessions ms
         JOIN users u ON u.id = ms.user_id
         WHERE ms.is_completed = FALSE
           AND ms.start_time <= NOW() - $1 * INTERVAL '1 hour'
           AND COALESCE(u.is_mining, FALSE) = FALSE
         ORDER BY ms.start_time ASC, ms.id ASC
         LIMIT $2
         FOR UPDATE OF ms SKIP LOCKED
       )
       UPDATE mining_sessions ms
       SET is_completed = TRUE,
           end_time = NOW(),
           status = 'orphaned_active_closed',
           reward = COALESCE(ms.reward, 0)
       FROM stale
       WHERE ms.id = stale.id
       RETURNING ms.id`,
      [SESSION_DURATION_HOURS + GRACE_PERIOD_HOURS, OVERDUE_SWEEP_BATCH_SIZE]
    );

    if (completed > 0 || blocked > 0 || failed > 0 || orphanCloseRes.rowCount > 0) {
      fastify.log.info({
        completed,
        blocked,
        failed,
        orphanClosed: orphanCloseRes.rowCount,
        scanned: overdueRes.rowCount,
      }, 'Overdue mining sweep applied');
    }
  }

  async function initializeMiningStartup() {
    await db.query(`
      SELECT 1
    `);
    await ensureMiningSchema();
    await ensureAntiAbuseSchema(db);
  }

  // Self-heal successful_sessions/total_sessions drift for recently-active
  // users. Undercount-only: never lowers a counter, never touches balances.
  async function reconcileSessionCounters() {
    const res = await db.query(
      `WITH recent_users AS (
         SELECT DISTINCT user_id
         FROM mining_sessions
         WHERE is_completed = TRUE
           AND status IN ('completed','completed_retroactive')
           AND end_time > NOW() - $1 * INTERVAL '1 hour'
       ),
       real AS (
         SELECT ms.user_id, COUNT(*) AS completed_rows
         FROM mining_sessions ms
         JOIN recent_users ru ON ru.user_id = ms.user_id
         WHERE ms.is_completed = TRUE
           AND ms.status IN ('completed','completed_retroactive')
         GROUP BY ms.user_id
       )
       UPDATE users u
       SET total_sessions      = r.completed_rows,
           successful_sessions = r.completed_rows,
           progress_percent    = LEAST(100, (r.completed_rows::double precision / 1000.0) * 100.0),
           is_eligible         = (r.completed_rows >= 1000),
           updated_at          = NOW()
       FROM real r
       WHERE r.user_id = u.id
         AND u.successful_sessions < r.completed_rows
       RETURNING u.id`,
      [SESSION_COUNTER_RECONCILE_LOOKBACK_HOURS]
    );
    if (res.rowCount > 0) {
      fastify.log.info({ reconciled: res.rowCount }, 'Session counter drift reconciled');
    }
  }

  // Always ensure critical session_proofs table exists, even if full schema sync is disabled
  // This prevents 500 errors on mining/status endpoints
  async function ensureSessionProofsTable() {
    try {
      await db.query(`
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
        )
      `);
      // Create indexes
      await db.query('CREATE INDEX IF NOT EXISTS idx_session_proofs_user_time ON session_proofs(user_id, created_at DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_session_proofs_status ON session_proofs(proof_status, created_at DESC)');
    } catch (err) {
      fastify.log.warn(err, 'Failed to ensure session_proofs table (may already exist)');
    }
  }

  // Ensure critical user columns exist (validator_status, etc.)
  async function ensureCriticalUserColumns() {
    const logger = fastify && fastify.log ? fastify.log : null;
    try {
      await addColumnIfMissing('users', 'validator_status', "VARCHAR(50) DEFAULT 'MINER'", { logger });
      await addColumnIfMissing('users', 'validator_reputation', 'INTEGER DEFAULT 0', { logger });
      await addColumnIfMissing('users', 'validator_key', 'TEXT', { logger });
      await addColumnIfMissing('users', 'validator_joined_at', 'TIMESTAMP', { logger });
      const { createIndexIfMissing } = require('../utils/schemaGuard');
      await createIndexIfMissing('idx_users_validator_status', 'CREATE INDEX idx_users_validator_status ON users(validator_status)', { logger });
    } catch (err) {
      if (logger) logger.warn(err, 'Failed to ensure validator_status columns (may already exist)');
    }
  }

  // Run critical schema setup
  try {
    await ensureSessionProofsTable();
    await ensureCriticalUserColumns();
  } catch (err) {
    fastify.log.error(err, 'Critical table/column setup failed (continuing)');
  }

  if (RUN_MINING_SCHEMA_SYNC_STARTUP) {
    try {
      await initializeMiningStartup();
    } catch (err) {
      fastify.log.error(err, 'Mining startup schema checks failed (continuing without blocking boot)');
    }
  } else {
    fastify.log.info('Mining startup schema checks skipped (RUN_MINING_SCHEMA_SYNC_STARTUP=false)');
  }

  if (OVERDUE_SWEEP_ENABLED) {
    setTimeout(() => {
      sweepOverdueActiveSessions().catch((err) => {
        fastify.log.error(err, 'Initial overdue mining sweep failed');
      });
    }, 15000);

    const sweepTimer = setInterval(() => {
      sweepOverdueActiveSessions().catch((err) => {
        fastify.log.error(err, 'Periodic overdue mining sweep failed');
      });
    }, OVERDUE_SWEEP_INTERVAL_MS);

    if (typeof sweepTimer.unref === 'function') {
      sweepTimer.unref();
    }
  }

  if (SESSION_COUNTER_RECONCILE_ENABLED) {
    setTimeout(() => {
      reconcileSessionCounters().catch((err) => {
        fastify.log.error(err, 'Initial session counter reconcile failed');
      });
    }, 30000);

    const reconcileTimer = setInterval(() => {
      reconcileSessionCounters().catch((err) => {
        fastify.log.error(err, 'Periodic session counter reconcile failed');
      });
    }, SESSION_COUNTER_RECONCILE_INTERVAL_MS);

    if (typeof reconcileTimer.unref === 'function') {
      reconcileTimer.unref();
    }
  }

  fastify.post('/session/claim', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    const securityEval = evaluateSecuritySignals(req);
    if (securityEval.shouldBlock) {
      await logAudit(db, {
        eventType: 'session_claim_blocked_insecure_runtime',
        userId,
        ip: req.ip,
        deviceId: securityEval.deviceId || null,
        deviceFingerprint: securityEval.deviceFingerprint || null,
        riskPoints: securityEval.risk,
        details: { reasons: securityEval.reasons },
      });
      return reply.code(403).send({ success: false, message: securityEval.blockReason });
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const statsRes = await client.query(
        `SELECT id, total_mined_ants, is_mining_active
         FROM network_stats
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE`
      );
      const stats = statsRes.rows[0];
      const issuanceEnded =
        Boolean(stats && stats.is_mining_active === false) ||
        Number(stats?.total_mined_ants || 0) >= MAX_SUPPLY_ANTS;
      if (issuanceEnded) {
        if (stats?.id && Boolean(stats.is_mining_active)) {
          await client.query(
            `UPDATE network_stats
             SET is_mining_active = FALSE,
                 updated_at = NOW()
             WHERE id = $1`,
            [stats.id]
          );
        }
        await client.query('ROLLBACK');
        return reply.code(409).send({ success: false, message: ISSUANCE_ENDED_MESSAGE });
      }

      const userRes = await client.query(
        `SELECT id, total_sessions, successful_sessions, progress_percent, last_session_time, session_end_time,
                notification_sent, ants_balance, ant_balance, is_eligible, preferred_language, is_banned
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId]
      );

      const user = userRes.rows[0];
      const lang = normalizeLang(user?.preferred_language || 'en');
      if (!user) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ success: false, message: t('error.user_not_found', lang) });
      }

      if (user.is_banned) {
        await client.query('ROLLBACK');
        return reply.code(403).send({ success: false, message: 'Your account has been suspended. Contact support.' });
      }

      const now = new Date();
      const effectiveTotal = Math.max(Number(user.total_sessions || 0), Number(user.successful_sessions || 0));
      if (effectiveTotal >= MAX_SESSIONS) {
        await client.query('ROLLBACK');
        return reply.code(400).send({ success: false, message: t('error.session_cap_reached', lang) });
      }

      if (user.last_session_time) {
        const elapsedMs = now.getTime() - new Date(user.last_session_time).getTime();
        const cooldownMs = SESSION_DURATION_HOURS * 60 * 60 * 1000;
        const maxWindowMs = (SESSION_DURATION_HOURS + GRACE_PERIOD_HOURS) * 60 * 60 * 1000;

        if (elapsedMs < cooldownMs) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ success: false, message: t('error.cooldown_active', lang) });
        }

        if (elapsedMs > maxWindowMs) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ success: false, message: t('error.session_missed', lang) });
        }
      }

      const nextTotalSessions = Math.min(MAX_SESSIONS, effectiveTotal + 1);
      const rewardAnts = BigInt(ANTS_PER_SESSION);
      // Use stored balance only — do NOT floor to sessions * ANTS_PER_SESSION
      // because successful_sessions may be inflated from legacy referral bonuses.
      const currentAnts = [
        BigInt(String(user.ants_balance || '0')),
        BigInt(String(user.ant_balance || '0')),
      ].reduce((max, value) => (value > max ? value : max), 0n);
      const updatedAnts = currentAnts + rewardAnts;
      const progressPercent = Number(((nextTotalSessions / MAX_SESSIONS) * 100).toFixed(4));
      const isEligible = nextTotalSessions >= MAX_SESSIONS;

      // Mark the most recent active mining_sessions row as completed.
      // If no active row exists AND no session was completed in the last 7 hours
      // (i.e. this is a claim-only user who never calls /start), insert one so
      // that completed_count stays in sync with total_sessions.
      // We do NOT insert if a recent completed row exists — that means
      // finalizeMiningSession already handled it and we must not duplicate.
      const sessionMarkRes = await client.query(
        `UPDATE mining_sessions
         SET is_completed = TRUE,
             end_time = NOW(),
             status = 'completed'
         WHERE id = (
           SELECT id FROM mining_sessions
           WHERE user_id = $1 AND is_completed = FALSE
           ORDER BY start_time DESC
           LIMIT 1
         )
         RETURNING id`,
        [userId]
      );
      if (sessionMarkRes.rowCount === 0) {
        await client.query(
          `INSERT INTO mining_sessions (user_id, start_time, end_time, is_completed, status)
           SELECT $1, NOW() - INTERVAL '6 hours', NOW(), TRUE, 'completed'
           WHERE NOT EXISTS (
             SELECT 1 FROM mining_sessions
             WHERE user_id = $1
               AND is_completed = TRUE
               AND end_time > NOW() - INTERVAL '7 hours'
           )`,
          [userId]
        );
      }

      const updatedUserRes = await client.query(
        `UPDATE users
         SET total_sessions = $2,
             successful_sessions = $2,
             ants_balance = $3,
             ant_balance = GREATEST(COALESCE(ant_balance, 0), $3::numeric),
             last_session_time = NOW(),
             session_end_time = NOW() + INTERVAL '6 hours',
             notification_sent = FALSE,
             progress_percent = $4,
             is_eligible = $5
         WHERE id = $1
         RETURNING total_sessions, progress_percent, ants_balance, is_eligible`,
        [userId, nextTotalSessions, updatedAnts.toString(), progressPercent, isEligible]
      );

      if (stats) {
        const statsId = stats.id;
        await client.query(
          `UPDATE network_stats
           SET total_mined_ants = COALESCE(total_mined_ants, 0) + $1::numeric,
               total_mined = ROUND((COALESCE(total_mined_ants, 0) + $1::numeric) / 100000000.0, 8),
               updated_at = NOW()
           WHERE id = $2`,
          [rewardAnts.toString(), statsId]
        );
      }

      await client.query('COMMIT');

      const row = updatedUserRes.rows[0];
      const antsBalance = BigInt(String(row.ants_balance || '0'));
      const anetBalance = Number(antsBalance) / Number(ANET_CONVERSION);
      return {
        success: true,
        message: t('success.session_claimed', lang),
        data: {
          total_sessions: Number(row.total_sessions || 0),
          progress_percent: Number(row.progress_percent || 0),
          sessions_left: Math.max(0, MAX_SESSIONS - Number(row.total_sessions || 0)),
          ants_balance: Number(antsBalance),
          anet_balance: Number(anetBalance.toFixed(8)),
          is_eligible: Boolean(row.is_eligible),
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      return reply.code(500).send({ success: false, message: t('error.session_claim_failed', 'en') });
    } finally {
      client.release();
    }
  });

  /// 🚀 START MINING
  fastify.post('/start', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req) => {

    /// 🔥 FIXED (support both JWT formats)
    const userId = req.user.userId || req.user.id;
    const ip = req.ip;
    const deviceFingerprint = String(req.headers['x-device-fingerprint'] || '').trim() || null;
    const securityEval = evaluateSecuritySignals(req, { deviceFingerprint });
    if (securityEval.shouldBlock) {
      await logAudit(db, {
        eventType: 'mining_start_blocked_insecure_runtime',
        userId,
        ip,
        deviceId: securityEval.deviceId || null,
        deviceFingerprint: deviceFingerprint || null,
        riskPoints: securityEval.risk,
        details: { reasons: securityEval.reasons },
      });
      return { error: securityEval.blockReason };
    }

    const userRes = await db.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    const user = userRes.rows[0];

    if (!user) {
      return { error: "User not found" };
    }

    if (user.is_banned) {
      return { error: 'Your account has been suspended. Contact support.' };
    }

    if (!user.email_verified) {
      await flagSuspicious(userId, 'attempt_start_without_email_verification');
      return { error: 'Email not verified. Verify OTP before starting mining.' };
    }

    if (!user.wallet_address) {
      await flagSuspicious(userId, 'attempt_start_without_wallet');
      return { error: 'Create your permanent wallet first before mining.' };
    }

    if (!user.device_id) {
      await flagSuspicious(userId, 'missing_device_binding');
      return { error: 'Device binding required before mining.' };
    }

    if (user.last_mining_start) {
      const lastStartMs = new Date(user.last_mining_start).getTime();
      if (Number.isFinite(lastStartMs) && (Date.now() - lastStartMs) < MINING_START_DEBOUNCE_MS) {
        // Idempotent behavior during debounce window: if an active session already
        // exists, treat repeated start calls as success instead of hard-failing.
        if (user.is_mining) {
          const activeSessionRes = await db.readQuery(
            `SELECT id, start_time
             FROM mining_sessions
             WHERE user_id = $1 AND is_completed = FALSE
             ORDER BY start_time DESC
             LIMIT 1`,
            [userId]
          );

          if (activeSessionRes.rows[0]) {
            const startValue = activeSessionRes.rows[0].start_time;
            const startMs = new Date(startValue).getTime();
            const remainingSeconds = Number.isFinite(startMs)
              ? Math.max(0, SESSION_SECONDS - Math.floor((Date.now() - startMs) / 1000))
              : SESSION_SECONDS;

            return {
              status: 'started',
              alreadyMining: true,
              resumed: true,
              remainingSeconds,
            };
          }
        }

        return { error: 'Mining start already received. Please wait a few seconds.' };
      }
    }

    /// ❌ prevent multiple sessions
    if (user.is_mining) {
      const activeSessionRes = await db.readQuery(
        `SELECT id, start_time
         FROM mining_sessions
         WHERE user_id = $1 AND is_completed = FALSE
         ORDER BY start_time DESC
         LIMIT 1`,
        [userId]
      );

      // Self-heal ghost is_mining flag when no active session row exists.
      if (!activeSessionRes.rows[0]) {
        await db.query(
          `UPDATE users
           SET is_mining = FALSE,
               last_mining_start = NULL
           WHERE id = $1`,
          [userId]
        );
      } else {
        const startValue = activeSessionRes.rows[0].start_time;
        const startMs = new Date(startValue).getTime();
        const remainingSeconds = Number.isFinite(startMs)
          ? Math.max(0, SESSION_SECONDS - Math.floor((Date.now() - startMs) / 1000))
          : SESSION_SECONDS;

        // Idempotent start: when a real active session exists, return success
        // so the app does not fall into the error path.
        return {
          status: 'started',
          alreadyMining: true,
          resumed: true,
          remainingSeconds,
        };
      }
    }

    /// ❌ prevent more than 4 sessions/day
    const dailySessionsRes = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM mining_sessions
       WHERE user_id = $1
         AND start_time >= CURRENT_DATE
         AND start_time < CURRENT_DATE + INTERVAL '1 day'`,
      [userId]
    );
    const sessionsToday = Number(dailySessionsRes.rows[0]?.count || 0);
    if (sessionsToday >= SESSIONS_PER_DAY) {
      await flagSuspicious(userId, 'daily_session_limit_exceeded');
      return {
        error: `Daily session limit reached (${SESSIONS_PER_DAY}/${SESSIONS_PER_DAY}). Come back tomorrow.`,
      };
    }

    const statsRes = await db.query(
      `SELECT id, total_mined_ants, is_mining_active
       FROM network_stats
       ORDER BY id ASC
       LIMIT 1`
    );
    const stats = statsRes.rows[0];
    const issuanceEnded =
      Boolean(stats && stats.is_mining_active === false) ||
      Number(stats?.total_mined_ants || 0) >= MAX_SUPPLY_ANTS;
    if (issuanceEnded) {
      if (stats?.id && Boolean(stats.is_mining_active)) {
        await db.query(
          `UPDATE network_stats
           SET is_mining_active = FALSE,
               updated_at = NOW()
           WHERE id = $1`,
          [stats.id]
        );
      }
      return { error: ISSUANCE_ENDED_MESSAGE, issuanceEnded: true };
    }

    /// ✅ start mining
    await db.query(`
      UPDATE users
      SET is_mining = true,
          last_mining_start = NOW(),
          last_ip = $1
      WHERE id = $2
    `, [ip, userId]);

    const activeSessionInsert = await db.query(
      `INSERT INTO mining_sessions (user_id, start_time, status, is_completed, last_heartbeat, heartbeat_count, started_ip)
       VALUES ($1, NOW(), 'active', FALSE, NOW(), 1, $2)
       RETURNING id, start_time, heartbeat_count`,
      [userId, ip]
    );
    const activeSessionRow = activeSessionInsert.rows[0];
    const sessionChallenge = await createSessionChallenge({
      wallet: user.wallet_address,
      migrationWallet: user.migration_wallet_address,
    });

    await db.query(
      `INSERT INTO session_proofs (
        session_id,
        user_id,
        wallet_address,
        migration_wallet,
        challenge_hash,
        challenge_seed,
        challenge_block_hash,
        challenge_timestamp,
        nonce,
        heartbeat_count,
        start_time,
        proof_status,
        is_verified,
        included_in_block
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',FALSE,FALSE)
      ON CONFLICT (session_id) DO UPDATE SET
        wallet_address = EXCLUDED.wallet_address,
        migration_wallet = EXCLUDED.migration_wallet,
        challenge_hash = EXCLUDED.challenge_hash,
        challenge_seed = EXCLUDED.challenge_seed,
        challenge_block_hash = EXCLUDED.challenge_block_hash,
        challenge_timestamp = EXCLUDED.challenge_timestamp,
        nonce = EXCLUDED.nonce,
        heartbeat_count = EXCLUDED.heartbeat_count,
        start_time = EXCLUDED.start_time,
        proof_status = 'pending',
        is_verified = FALSE,
        included_in_block = FALSE`,
      [
        activeSessionRow.id,
        userId,
        user.wallet_address,
        user.migration_wallet_address || null,
        sessionChallenge.challengeHash,
        sessionChallenge.randomSeed,
        sessionChallenge.currentBlockHash,
        sessionChallenge.challengeTimestamp,
        crypto.randomBytes(16).toString('hex'),
        Number(activeSessionRow.heartbeat_count || 0),
        activeSessionRow.start_time,
      ]
    );

    const validatorState = buildValidatorCandidateState({
      wallet: user.wallet_address,
      migrationWallet: user.migration_wallet_address,
      emailVerified: Boolean(user.email_verified),
      isBanned: Boolean(user.is_banned),
      riskScore: Number(user.risk_score || 0),
      totalSessions: Number(user.total_sessions || user.successful_sessions || 0),
    });
    if (validatorState.isValidatorCandidate) {
      try {
        await db.query(
          `UPDATE users
           SET is_validator_candidate = TRUE,
               validator_status = $2,
               validator_joined_at = COALESCE(validator_joined_at, NOW()),
               validator_key = COALESCE(validator_key, $3),
               validator_reputation = COALESCE(validator_reputation, 0)
           WHERE id = $1`,
          [userId, validatorState.validatorStatus, validatorState.validatorKey]
        );
      } catch (validatorErr) {
        if (validatorErr?.code !== '42703') throw validatorErr;
        fastify.log.warn(
          { userId, err: validatorErr?.message },
          'validator update skipped due to schema mismatch; continuing mining start'
        );
      }
    }

    await logAudit(db, {
      eventType: 'mining_start',
      userId,
      ip,
      deviceId: user.device_id,
      deviceFingerprint,
      details: {
        sessionsToday: sessionsToday + 1,
        dailyLimit: SESSIONS_PER_DAY,
      },
    });

    return { status: "started", sessionsPerDay: SESSIONS_PER_DAY, sessionsToday: sessionsToday + 1 };
  });


  /// ⏱ CHECK STATUS
  fastify.get('/status/:userId', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {

    const { userId } = req.params;
    const requesterId = Number(req.user.userId || req.user.id);
    const requestedUserId = Number(userId);

    if (!requesterId) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // Backward compatibility: some app builds may send a stale/null userId in URL.
    // Always serve status for the authenticated user from token claims.
    if (Number.isFinite(requestedUserId) && requestedUserId !== requesterId) {
      await flagSuspicious(requesterId, 'status_user_id_mismatch', {
        requestedUserId,
      });
    }

    const statusCacheKey = String(requesterId);
    if (isDbPressureHigh()) {
      const cached = getFreshCached(miningStatusCache, statusCacheKey);
      if (cached) {
        return cached;
      }
    }

    const respondWithStatus = (payload) => {
      setCached(miningStatusCache, statusCacheKey, payload, MINING_STATUS_CACHE_MS);
      return payload;
    };

    let result;
    try {
      result = await db.readQuery(
        `SELECT * FROM users WHERE id = $1`,
        [requesterId]
      );
    } catch (err) {
      const cached = getFreshCached(miningStatusCache, statusCacheKey);
      if (cached && isDbConnectTimeoutError(err)) {
        return cached;
      }
      throw err;
    }

    const user = result.rows[0];

    if (!user) {
      return respondWithStatus({ isMining: false });
    }

    let activeSessionRes;
    try {
      activeSessionRes = await db.readQuery(
        `SELECT id, start_time, last_heartbeat, heartbeat_count
         FROM mining_sessions
         WHERE user_id = $1 AND is_completed = FALSE
         ORDER BY start_time DESC
         LIMIT 1`,
        [requesterId]
      );
    } catch (err) {
      const cached = getFreshCached(miningStatusCache, statusCacheKey);
      if (cached && isDbConnectTimeoutError(err)) {
        return cached;
      }
      throw err;
    }

    const sessionStartValue = activeSessionRes.rows[0]?.start_time || user.last_mining_start;
    if (!sessionStartValue) {
      await db.query(
        `UPDATE users
         SET is_mining = FALSE,
             last_mining_start = NULL
         WHERE id = $1`,
        [requesterId]
      );
      return respondWithStatus({ isMining: false });
    }

    const start = new Date(sessionStartValue);
    const startMs = start.getTime();
    if (!Number.isFinite(startMs)) {
      await db.query(
        `UPDATE users
         SET is_mining = FALSE,
             last_mining_start = NULL
         WHERE id = $1`,
        [requesterId]
      );
      return respondWithStatus({ isMining: false });
    }

    const now = new Date();

    const diffSeconds = Math.floor((now - start) / 1000);
    const remaining = Math.max(0, SESSION_SECONDS - diffSeconds);

    if (remaining <= 0) {
      const completion = await finalizeMiningSession({
        userId: requesterId,
        ip: req.ip,
        req,
        autoTriggered: true,
      });

      if (completion?.error) {
        return respondWithStatus({
          isMining: false,
          autoCompleted: false,
          autoCompletionError: completion.error,
        });
      }

      return respondWithStatus({
        isMining: false,
        autoCompleted: true,
        completion,
      });
    }

    return respondWithStatus({
      isMining: true,
      remainingSeconds: remaining,
    });
  });

  /// ❤️ HEARTBEAT (proof-of-authenticity)
  fastify.post('/heartbeat', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 100, timeWindow: '15 minutes' },
    },
  }, async (req) => {
    if (isDbPressureHigh()) {
      return { ok: false, error: 'Service busy, please retry.' };
    }

    const userId = req.user.userId || req.user.id;
    const ip = req.ip;
    const heartbeatRes = await db.query(
      `UPDATE mining_sessions
       SET last_heartbeat = NOW(),
           heartbeat_count = COALESCE(heartbeat_count, 0) + 1
       WHERE id = (
         SELECT id
         FROM mining_sessions
         WHERE user_id = $1
           AND is_completed = FALSE
         ORDER BY start_time DESC
         LIMIT 1
       )
       RETURNING id, heartbeat_count, last_heartbeat`,
      [userId]
    );

    if (!heartbeatRes.rows[0]) {
      return { ok: false, error: 'No active mining session' };
    }

    await logAudit(db, {
      eventType: 'mining_heartbeat',
      userId,
      sessionId: heartbeatRes.rows[0].id,
      ip,
      details: {
        heartbeatCount: Number(heartbeatRes.rows[0].heartbeat_count || 0),
      },
    });

    return {
      ok: true,
      sessionId: heartbeatRes.rows[0].id,
      heartbeatCount: Number(heartbeatRes.rows[0].heartbeat_count || 0),
      lastHeartbeat: heartbeatRes.rows[0].last_heartbeat,
    };
  });


  /// ✅ COMPLETE MINING
  fastify.post('/complete', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req) => {
    const userId = req.user.userId || req.user.id;
    return finalizeMiningSession({
      userId,
      ip: req.ip,
      req,
      autoTriggered: false,
    });
  });

  /// 💱 CLAIM ANET FROM MINED ANTS (requires 1000 sessions)
  fastify.post('/claim', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req) => {
    const userId = req.user.userId || req.user.id;
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const userRes = await client.query(
        `SELECT id, successful_sessions, ant_balance, ants_balance, balance, claimed_anet, risk_score, is_flagged, is_banned, device_id, device_fingerprint
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        await client.query('ROLLBACK');
        return { error: 'User not found' };
      }
      if (user.is_banned) {
        await client.query('ROLLBACK');
        return { error: 'Your account has been suspended. Contact support.' };
      }

      const completedRes = await client.query(
        `SELECT COUNT(*)::int AS completed_sessions
         FROM mining_sessions
         WHERE user_id = $1
           AND is_completed = TRUE
           AND COALESCE(status, '') = 'completed'`,
        [userId]
      );
      const actualCompletedSessions = Number(completedRes.rows[0]?.completed_sessions || 0);

      if (actualCompletedSessions < REQUIRED_SESSIONS_FOR_ELIGIBILITY) {
        await client.query('ROLLBACK');
        await logAudit(db, {
          eventType: 'claim_blocked_sessions',
          userId,
          ip: req.ip,
          deviceId: user.device_id,
          deviceFingerprint: user.device_fingerprint,
          details: {
            totalSessions: Number(user.successful_sessions || 0),
            actualCompletedSessions,
            required: REQUIRED_SESSIONS_FOR_ELIGIBILITY,
          },
        });
        return {
          error: 'Not eligible yet. Complete at least 1000 verified sessions to claim ANET.',
          totalSessions: Number(user.successful_sessions || 0),
          actualCompletedSessions,
          requiredSessionsForEligibility: REQUIRED_SESSIONS_FOR_ELIGIBILITY,
        };
      }

      const cfg = antiAbuseConfig();
      if (Boolean(user.is_flagged) || Number(user.risk_score || 0) > cfg.riskBlockThreshold) {
        await client.query('ROLLBACK');
        await logAudit(db, {
          eventType: 'claim_blocked_risk',
          userId,
          ip: req.ip,
          deviceId: user.device_id,
          deviceFingerprint: user.device_fingerprint,
          riskPoints: Number(user.risk_score || 0),
          details: {
            isFlagged: Boolean(user.is_flagged),
            threshold: cfg.riskBlockThreshold,
          },
        });
        return {
          error: 'Claim blocked due to security risk. Please contact support for review.',
        };
      }

      const antsBalance = Math.max(
        Number(user.ant_balance || 0),
        Number(user.ants_balance || 0)
      );
      if (antsBalance <= 0) {
        await client.query('ROLLBACK');
        return { error: 'No ANTS available to convert.' };
      }

      const netRes = await client.query(
        `SELECT id, total_sessions, total_mined_ants, total_anet_distributed, is_mining_active, halving_count
         FROM network_stats
         LIMIT 1
         FOR UPDATE`
      );
      const net = netRes.rows[0];
      const verifiedSessionCount = Math.min(
        Number(user.successful_sessions || 0),
        actualCompletedSessions
      );
      const globalState = buildGlobalState({
        totalSessions: Number(net?.total_sessions || 0),
        totalANETClaimed: Number(net?.total_anet_distributed || 0),
        totalANTSAccumulated: Number(net?.total_mined_ants || 0),
        halvingStage: Number(net?.halving_count || 0),
        isMiningActive: Boolean(net?.is_mining_active),
      });
      const claimAnet = safeConvert(
        {
          totalSessions: verifiedSessionCount,
          totalANTS: antsBalance,
        },
        globalState
      );

      if (claimAnet <= 0) {
        await client.query('ROLLBACK');
        return { error: 'ANET max supply already distributed. The network remains active, but no newly issued ANET is available to claim.' };
      }

      const claimAnts = anetToAnts(claimAnet);

      const userUpdateRes = await client.query(
        `UPDATE users
         SET ants_balance = GREATEST(GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) - $1, 0),
             ant_balance = GREATEST(GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) - $1, 0),
             balance = ROUND(COALESCE(balance, 0) + $2, 8),
             claimed_anet = ROUND(COALESCE(claimed_anet, 0) + $2, 8)
         WHERE id = $3
         RETURNING balance, claimed_anet,
                   GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) AS effective_ant_balance`,
        [claimAnts, claimAnet, userId]
      );

      const netUpdateRes = await client.query(
        `UPDATE network_stats
         SET total_anet_distributed = ROUND(COALESCE(total_anet_distributed, 0) + $1, 8)
         WHERE id = $2
         RETURNING total_anet_distributed`,
        [claimAnet, net.id]
      );

      await client.query(
        `INSERT INTO ant_transactions (user_id, transaction_type, amount, description, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          userId,
          'mining_claim',
          Number(claimAnet.toFixed(8)),
          `Verified mining claim from ${claimAnts} ANTS after ${verifiedSessionCount} completed sessions`,
          'completed',
        ]
      );

      await client.query('COMMIT');

      const updatedUserState = buildUserMiningState({
        id: userId,
        successful_sessions: verifiedSessionCount,
        ant_balance: userUpdateRes.rows[0]?.effective_ant_balance || 0,
        claimed_anet: userUpdateRes.rows[0]?.claimed_anet || 0,
      });

      return {
        claimedAnet: Number(claimAnet.toFixed(8)),
        claimedAnts: claimAnts,
        user: {
          ...updatedUserState,
          anetBalance: Number(userUpdateRes.rows[0]?.balance || 0),
          remainingAnts: Number(userUpdateRes.rows[0]?.effective_ant_balance || 0),
          actualCompletedSessions,
        },
        global: {
          totalANETClaimed: Number(netUpdateRes.rows[0]?.total_anet_distributed || 0),
          maxSupply: MAX_SUPPLY,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      return { error: 'Failed to claim ANET' };
    } finally {
      client.release();
    }
  });

  fastify.get('/fraud-clusters', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const ipClusters = await db.query(
      `SELECT last_ip, COUNT(*)::int AS users
       FROM users
       WHERE last_ip IS NOT NULL
         AND TRIM(last_ip) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY last_ip
       HAVING COUNT(*) >= 3
       ORDER BY COUNT(*) DESC
       LIMIT 50`
    );

    const deviceClusters = await db.query(
      `SELECT device_id, COUNT(*)::int AS users
       FROM users
       WHERE device_id IS NOT NULL
         AND TRIM(device_id) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY device_id
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC
       LIMIT 50`
    );

    const fingerprintClusters = await db.query(
      `SELECT device_fingerprint, COUNT(*)::int AS users
       FROM users
       WHERE device_fingerprint IS NOT NULL
         AND TRIM(device_fingerprint) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY device_fingerprint
       HAVING COUNT(*) >= 2
       ORDER BY COUNT(*) DESC
       LIMIT 50`
    );

    return {
      ipClusters: ipClusters.rows,
      deviceClusters: deviceClusters.rows,
      fingerprintClusters: fingerprintClusters.rows,
    };
  });

  fastify.get('/bot-cleanup/preview', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    try {
      return await previewCleanup(db);
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to preview bot cleanup' });
    }
  });

  fastify.post('/bot-cleanup/apply', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    if (req.body?.confirm !== 'DELETE_SUSPICIOUS_UNVERIFIED_USERS') {
      return reply.code(400).send({
        error: 'Confirmation token required',
        expectedConfirm: 'DELETE_SUSPICIOUS_UNVERIFIED_USERS',
      });
    }

    try {
      const result = await applyCleanup(db);
      return {
        message: 'Suspicious unverified users were soft-deleted.',
        ...result,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to apply bot cleanup' });
    }
  });

  fastify.get('/bot-review/verified', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    try {
      return await previewVerifiedReview(db);
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to review verified accounts' });
    }
  });

  /// ♻️ HARD RESET MINING (keep accounts + wallet addresses)
  fastify.post('/reset-hard', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    await ensureMiningSchema();

    let txStarted = false;
    try {
      await db.query('BEGIN');
      txStarted = true;

      await db.query(`
        UPDATE users
        SET ant_balance = 0,
            balance = 0,
            claimed_anet = 0,
            successful_sessions = 0,
            is_mining = FALSE,
            last_mining_start = NULL,
            suspicious_flags = 0,
            suspicious_reason = NULL,
            updated_at = NOW()
      `);

      await db.query('TRUNCATE TABLE mining_sessions RESTART IDENTITY');

      await db.query(`
        UPDATE network_stats
        SET total_users = (SELECT COUNT(*)::int FROM users WHERE COALESCE(is_deleted, FALSE) = FALSE),
            eligible_users = 0,
            total_sessions = 0,
            halving_count = 0,
            total_mined = 0,
            total_mined_ants = 0,
            total_anet_distributed = 0,
            is_mining_active = TRUE,
            updated_at = NOW()
      `);

      await db.query('COMMIT');
      txStarted = false;

      const statsRes = await db.query(
        `SELECT total_users, eligible_users, total_sessions, halving_count, total_mined_ants, total_anet_distributed, is_mining_active
         FROM network_stats
         LIMIT 1`
      );
      const stats = statsRes.rows[0] || {};
      return {
        message: 'Hard reset completed for mining state. Accounts and wallet addresses were kept.',
        globalState: buildGlobalState({
          totalUsers: Number(stats.total_users || 0),
          totalSessions: Number(stats.total_sessions || 0),
          totalCompletedSessions: Number(stats.total_sessions || 0),
          totalEligibleUsers: Number(stats.eligible_users || 0),
          totalActiveMiners: 0,
          totalConvertedUsers: 0,
          totalANTSAccumulated: Number(stats.total_mined_ants || 0),
          totalANETClaimed: Number(stats.total_anet_distributed || 0),
          halvingStage: Number(stats.halving_count || 0),
          isMiningActive: Boolean(stats.is_mining_active),
        }),
      };
    } catch (err) {
      if (txStarted) {
        await db.query('ROLLBACK');
      }
      return reply.code(500).send({ error: 'Hard reset failed' });
    }
  });


  /// 📋 MINING SESSION HISTORY
  fastify.get('/sessions', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 60, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 50);
    const offset = Math.max(parseInt(req.query.offset ?? '0', 10), 0);
    const sessionsCacheKey = `${userId}:${limit}:${offset}`;

    if (isDbPressureHigh()) {
      const cached = getFreshCached(miningSessionsCache, sessionsCacheKey);
      if (cached) {
        return cached;
      }
    }

    let userRes;
    try {
      userRes = await db.readQuery(
        `SELECT id, successful_sessions, balance, ant_balance, created_at, last_mining_start, is_mining, referred_by
         FROM users WHERE id = $1`,
        [userId]
      );
    } catch (err) {
      const cached = getFreshCached(miningSessionsCache, sessionsCacheKey);
      if (cached && isDbConnectTimeoutError(err)) {
        return cached;
      }
      throw err;
    }
    const user = userRes.rows[0];
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    let currentRate = null;
    try {
      const netRes = await db.readQuery(`SELECT halving_count, total_sessions FROM network_stats LIMIT 1`);
      const halvingCount = Number(netRes.rows[0]?.halving_count ?? 0);
      const totalNetworkSessions = Number(netRes.rows[0]?.total_sessions ?? 0);
      const { calculateRate } = require('../services/miningEngine');
      const totalCompletedSessions = Number(user.successful_sessions ?? 0);
      currentRate = calculateRate(
        halvingCount,
        totalNetworkSessions > 0 ? totalNetworkSessions : totalCompletedSessions,
      );
    } catch (_) {}

    let sessionsRes;
    let countRes;
    try {
      sessionsRes = await db.readQuery(
        `SELECT
           ms.id,
           ms.start_time,
           ms.end_time,
           ms.reward,
           ms.halving_level,
           ms.is_completed,
           ms.status,
           ms.created_at,
           sp.block_height,
           CASE
             WHEN ms.is_completed = TRUE AND COALESCE(ms.status, '') = 'completed'
               THEN COALESCE(ms.reward, 0)
             ELSE 0
           END AS credited_reward,
           ROW_NUMBER() OVER (
             ORDER BY ms.start_time ASC, ms.id ASC
           ) AS seq_number
         FROM mining_sessions ms
         LEFT JOIN session_proofs sp ON sp.session_id = ms.id
         WHERE ms.user_id = $1
         ORDER BY ms.start_time DESC, ms.id DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      countRes = await db.readQuery(
        `SELECT COUNT(*) as total FROM mining_sessions WHERE user_id = $1`,
        [userId]
      );
    } catch (err) {
      const cached = getFreshCached(miningSessionsCache, sessionsCacheKey);
      if (cached && isDbConnectTimeoutError(err)) {
        return cached;
      }
      throw err;
    }

    const payload = {
      profile: {
        userId: user.id,
        miningStartDate: user.created_at,
        successfulSessions: Number(user.successful_sessions ?? 0),
        antsBalance: Number(user.balance ?? 0),
        antBalance: Number(user.ant_balance ?? 0),
        currentRate,
        isMining: user.is_mining,
        lastMiningStart: user.last_mining_start,
        colonyJoinedAt: user.referred_by ? user.created_at : null,
        hasColony: user.referred_by != null,
      },
      sessions: sessionsRes.rows,
      total: Number(countRes.rows[0]?.total ?? 0),
      limit,
      offset,
    };

    setCached(miningSessionsCache, sessionsCacheKey, payload, MINING_SESSIONS_CACHE_MS);
    return payload;
  });

};