const DEFAULTS = {
  DEVICE_MAX_ACCOUNTS: 10,
  FINGERPRINT_MAX_ACCOUNTS: 10,
  HEARTBEAT_MAX_GAP_MINUTES: 120,
  HEARTBEAT_MIN_REQUIRED: 2,
  IP_CLUSTER_ACCOUNT_THRESHOLD: 50,
  FINGERPRINT_CLUSTER_ACCOUNT_THRESHOLD: 20,
  RISK_BLOCK_THRESHOLD: 10,
  BOT_PATTERN_LOOKBACK: 8,
  REQUIRE_OFFICIAL_CLIENT_HEADERS: false,
};

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function config() {
  return {
    deviceMaxAccounts: envInt('DEVICE_MAX_ACCOUNTS', DEFAULTS.DEVICE_MAX_ACCOUNTS),
    fingerprintMaxAccounts: envInt(
      'FINGERPRINT_MAX_ACCOUNTS',
      DEFAULTS.FINGERPRINT_MAX_ACCOUNTS
    ),
    heartbeatMaxGapMinutes: envInt(
      'MINING_HEARTBEAT_MAX_GAP_MINUTES',
      DEFAULTS.HEARTBEAT_MAX_GAP_MINUTES
    ),
    heartbeatMinRequired: envInt(
      'MINING_HEARTBEAT_MIN_REQUIRED',
      DEFAULTS.HEARTBEAT_MIN_REQUIRED
    ),
    ipClusterThreshold: envInt(
      'IP_CLUSTER_ACCOUNT_THRESHOLD',
      DEFAULTS.IP_CLUSTER_ACCOUNT_THRESHOLD
    ),
    fingerprintClusterThreshold: envInt(
      'FINGERPRINT_CLUSTER_ACCOUNT_THRESHOLD',
      DEFAULTS.FINGERPRINT_CLUSTER_ACCOUNT_THRESHOLD
    ),
    riskBlockThreshold: envInt(
      'ANTI_ABUSE_RISK_BLOCK_THRESHOLD',
      DEFAULTS.RISK_BLOCK_THRESHOLD
    ),
    botPatternLookback: envInt(
      'BOT_PATTERN_LOOKBACK',
      DEFAULTS.BOT_PATTERN_LOOKBACK
    ),
    requireOfficialClientHeaders:
      String(
        process.env.REQUIRE_OFFICIAL_CLIENT_HEADERS ??
          DEFAULTS.REQUIRE_OFFICIAL_CLIENT_HEADERS
      ).toLowerCase() !== 'false',
    blockInsecureRuntime: String(process.env.BLOCK_INSECURE_RUNTIME || 'false').toLowerCase() !== 'false',
  };
}

function normalizeSecurityFlags(value) {
  return String(value || '')
    .split(',')
    .map((flag) => flag.trim().toLowerCase())
    .filter(Boolean);
}

function extractSecuritySignals(req, options = {}) {
  const headers = req?.headers || {};
  const body = options.body || req?.body || {};
  const headerDeviceId = String(headers['x-device-id'] || '').trim();
  const bodyDeviceId = String(body.deviceId || '').trim();
  const deviceFingerprint = String(
    options.deviceFingerprint || body.deviceFingerprint || headers['x-device-fingerprint'] || ''
  ).trim();

  return {
    runtime: String(headers['x-app-runtime'] || '').trim().toLowerCase(),
    flags: normalizeSecurityFlags(headers['x-app-security-flags']),
    deviceId: bodyDeviceId || headerDeviceId,
    headerDeviceId,
    bodyDeviceId,
    deviceFingerprint,
  };
}

function evaluateSecuritySignals(req, options = {}) {
  const cfg = config();
  const signals = extractSecuritySignals(req, options);
  const reasons = [];
  let risk = 0;
  let shouldBlock = false;
  let blockReason = null;
  const hasLegacyCompatibleHeaders = Boolean(
    signals.deviceFingerprint && signals.deviceId
  );

  if (!signals.deviceFingerprint) {
    risk += 2;
    reasons.push('missing_device_fingerprint');
    if (cfg.requireOfficialClientHeaders && signals.runtime !== 'debug') {
      shouldBlock = true;
      blockReason = 'Official app security headers are required. Please update to the latest app build.';
    }
  } else if (!/^[A-Za-z0-9_-]{16,128}$/.test(signals.deviceFingerprint)) {
    risk += 2;
    reasons.push('invalid_device_fingerprint_format');
    if (cfg.requireOfficialClientHeaders && signals.runtime !== 'debug') {
      shouldBlock = true;
      blockReason = 'Invalid device fingerprint detected. Please use the official app build.';
    }
  }

  if (!signals.deviceId) {
    risk += 1;
    reasons.push('missing_device_id');
  }

  if (signals.headerDeviceId && signals.bodyDeviceId && signals.headerDeviceId !== signals.bodyDeviceId) {
    risk += 3;
    reasons.push('device_id_header_body_mismatch');
  }

  if (signals.runtime && !['debug', 'release'].includes(signals.runtime)) {
    risk += 1;
    reasons.push(`unexpected_runtime:${signals.runtime}`);
    if (cfg.requireOfficialClientHeaders) {
      shouldBlock = true;
      blockReason = 'Unsupported app runtime detected. Please use the official mobile app.';
    }
  }

  if (!signals.runtime) {
    risk += 2;
    reasons.push('missing_runtime');
    if (cfg.requireOfficialClientHeaders && !hasLegacyCompatibleHeaders) {
      shouldBlock = true;
      blockReason = 'Missing app runtime header. Please use the official mobile app.';
    }
  }

  if (signals.flags.includes('debug_runtime') && signals.runtime === 'release') {
    risk += 2;
    reasons.push('runtime_flag_mismatch');
  }

  const insecureFlags = signals.flags.filter((flag) =>
    [
      'emulator_detected',
      'non_physical_device',
      'unsupported_platform',
      'root_detected',
      'jailbreak_detected',
      'developer_build',
    ].includes(flag)
  );

  if (insecureFlags.length > 0) {
    risk += 5;
    reasons.push(...insecureFlags);
    if (cfg.blockInsecureRuntime && signals.runtime !== 'debug') {
      shouldBlock = true;
      blockReason = 'Insecure runtime detected. Please use the official app on a non-rooted physical device.';
    }
  }

  return {
    ...signals,
    risk,
    reasons,
    shouldBlock,
    blockReason,
  };
}

async function ensureAntiAbuseSchema(db) {
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS device_fingerprint TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS risk_score INT DEFAULT 0');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS flag_reason TEXT');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_risk_at TIMESTAMP');

  await db.query(`
    CREATE TABLE IF NOT EXISTS mining_sessions (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP,
      reward DECIMAL(20, 8) DEFAULT 0,
      halving_level INT DEFAULT 0,
      is_completed BOOLEAN DEFAULT FALSE,
      status VARCHAR(255) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query('ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP');
  await db.query('ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS heartbeat_count INT DEFAULT 0');
  await db.query('ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE');
  await db.query('ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS started_ip TEXT');
  await db.query('ALTER TABLE mining_sessions ADD COLUMN IF NOT EXISTS completed_ip TEXT');

  await db.query('CREATE INDEX IF NOT EXISTS idx_users_device_id ON users(device_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_last_ip ON users(last_ip)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_device_fingerprint ON users(device_fingerprint)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_risk_score ON users(risk_score)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_sessions_last_heartbeat ON mining_sessions(last_heartbeat)');
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_mining_sessions_active_user_time
    ON mining_sessions(user_id, start_time DESC)
    WHERE is_completed = FALSE
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_mining_sessions_completed_user_time
    ON mining_sessions(user_id, start_time DESC)
    WHERE is_completed = TRUE AND COALESCE(status, '') = 'completed'
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_mining_sessions_overdue_start_user
    ON mining_sessions(start_time DESC, user_id)
    WHERE is_completed = FALSE
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS security_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      user_id INT,
      session_id INT,
      ip TEXT,
      device_id TEXT,
      device_fingerprint TEXT,
      risk_points INT DEFAULT 0,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_security_audit_user_id ON security_audit_logs(user_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_security_audit_event_type ON security_audit_logs(event_type)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_security_audit_created_at ON security_audit_logs(created_at DESC)');
}

async function logAudit(db, payload) {
  const {
    eventType,
    userId = null,
    sessionId = null,
    ip = null,
    deviceId = null,
    deviceFingerprint = null,
    riskPoints = 0,
    details = {},
  } = payload || {};

  if (!eventType) return;

  // Fire-and-forget: audit logs are best-effort and must never block request handling.
  // Callers may still `await` this function; it resolves immediately regardless.
  db.query(
    `INSERT INTO security_audit_logs
     (event_type, user_id, session_id, ip, device_id, device_fingerprint, risk_points, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      String(eventType),
      userId,
      sessionId,
      ip,
      deviceId,
      deviceFingerprint,
      Number(riskPoints || 0),
      JSON.stringify(details || {}),
    ]
  ).catch(() => {
    // Intentionally silent: audit log failures must not surface to callers.
  });
}

async function addRisk(db, userId, points, reason, options = {}) {
  if (!userId || !points) return null;
  const shouldFlag = Boolean(options.flag);

  const res = await db.query(
    `UPDATE users
     SET risk_score = COALESCE(risk_score, 0) + $1,
         is_flagged = CASE WHEN $4 THEN TRUE ELSE COALESCE(is_flagged, FALSE) END,
         flag_reason = CASE
           WHEN $4 THEN COALESCE($3, flag_reason)
           ELSE flag_reason
         END,
         last_risk_at = NOW()
     WHERE id = $2
     RETURNING id, risk_score, is_flagged`,
    [Number(points), userId, reason || null, shouldFlag]
  );

  return res.rows[0] || null;
}

async function validateDeviceLimit(db, deviceId, currentUserId = null) {
  const cfg = config();
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId) {
    throw new Error('Device binding required');
  }

  const params = [normalizedDeviceId];
  const countLimit = Math.max(1, Number(cfg.deviceMaxAccounts || 1));
  let sql = `
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT 1
      FROM users
      WHERE device_id = $1
        AND COALESCE(is_deleted, FALSE) = FALSE
  `;

  if (currentUserId) {
    params.push(Number(currentUserId));
    sql += ' AND id <> $2';
  }

  params.push(countLimit);
  sql += `
      LIMIT $${params.length}
    ) limited_users
  `;

  const countRes = await db.query(sql, params);
  const count = Number(countRes.rows[0]?.count || 0);

  if (count >= cfg.deviceMaxAccounts) {
    throw new Error('Device account limit reached');
  }
}

async function validateFingerprintLimit(db, deviceFingerprint, currentUserId = null) {
  const cfg = config();
  const normalizedFingerprint = String(deviceFingerprint || '').trim();
  if (!normalizedFingerprint) {
    throw new Error('Device fingerprint required');
  }

  const params = [normalizedFingerprint];
  const countLimit = Math.max(1, Number(cfg.fingerprintMaxAccounts || 1));
  let sql = `
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT 1
      FROM users
      WHERE device_fingerprint = $1
        AND COALESCE(is_deleted, FALSE) = FALSE
  `;

  if (currentUserId) {
    params.push(Number(currentUserId));
    sql += ' AND id <> $2';
  }

  params.push(countLimit);
  sql += `
      LIMIT $${params.length}
    ) limited_users
  `;

  const countRes = await db.query(sql, params);
  const count = Number(countRes.rows[0]?.count || 0);

  if (count >= cfg.fingerprintMaxAccounts) {
    throw new Error('Device fingerprint account limit reached');
  }
}

function detectBotPattern(sessions = []) {
  if (!Array.isArray(sessions) || sessions.length < 4) {
    return { suspicious: false, reasons: [] };
  }

  const reasons = [];

  const minuteOfDay = sessions
    .map((s) => new Date(s.start_time))
    .filter((d) => !Number.isNaN(d.getTime()))
    .map((d) => d.getUTCHours() * 60 + d.getUTCMinutes());

  if (minuteOfDay.length >= 4) {
    const min = Math.min(...minuteOfDay);
    const max = Math.max(...minuteOfDay);
    if (max - min <= 2) {
      reasons.push('identical_start_time_pattern');
    }
  }

  const durationSeconds = sessions
    .map((s) => {
      const start = new Date(s.start_time).getTime();
      const end = new Date(s.end_time || s.start_time).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      return Math.max(0, Math.round((end - start) / 1000));
    })
    .filter((v) => Number.isFinite(v));

  if (durationSeconds.length >= 4) {
    const nearPerfect = durationSeconds.every((d) => d >= 21300 && d <= 21900);
    if (nearPerfect) {
      reasons.push('perfect_duration_pattern');
    }
  }

  return { suspicious: reasons.length > 0, reasons };
}

async function evaluateRisk(db, payload = {}) {
  const cfg = config();
  const {
    userId,
    ip,
    deviceId,
    deviceFingerprint,
  } = payload;

  let risk = 0;
  const reasons = [];

  if (ip) {
    const ipLimit = Math.max(1, Number(cfg.ipClusterThreshold || 1));
    const ipRes = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT 1
         FROM users
         WHERE last_ip = $1
           AND COALESCE(is_deleted, FALSE) = FALSE
           AND ($2::int IS NULL OR id <> $2::int)
         LIMIT $3
       ) limited_users`,
      [ip, userId ? Number(userId) : null, ipLimit]
    );

    const ipCount = Number(ipRes.rows[0]?.count || 0);
    if (ipCount >= cfg.ipClusterThreshold) {
      risk += 2;
      reasons.push(`ip_cluster:${ipCount}`);
    }
  }

  if (deviceId) {
    const devLimit = Math.max(2, Number(cfg.deviceMaxAccounts || 1) + 1);
    const devRes = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT 1
         FROM users
         WHERE device_id = $1
           AND COALESCE(is_deleted, FALSE) = FALSE
           AND ($2::int IS NULL OR id <> $2::int)
         LIMIT $3
       ) limited_users`,
      [deviceId, userId ? Number(userId) : null, devLimit]
    );

    const devCount = Number(devRes.rows[0]?.count || 0);
    if (devCount >= 1) {
      risk += 1;
      reasons.push(`shared_device:${devCount + 1}`);
    }
    if (devCount + 1 > cfg.deviceMaxAccounts) {
      risk += 4;
      reasons.push(`device_limit_exceeded:${devCount + 1}`);
    }
  }

  if (deviceFingerprint) {
    const fpLimit = Math.max(2, Number(cfg.fingerprintClusterThreshold || 1) + 1);
    const fpRes = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM (
         SELECT 1
         FROM users
         WHERE device_fingerprint = $1
           AND COALESCE(is_deleted, FALSE) = FALSE
           AND ($2::int IS NULL OR id <> $2::int)
         LIMIT $3
       ) limited_users`,
      [deviceFingerprint, userId ? Number(userId) : null, fpLimit]
    );

    const fpCount = Number(fpRes.rows[0]?.count || 0);
    if (fpCount >= cfg.fingerprintClusterThreshold) {
      risk += 2;
      reasons.push(`fingerprint_cluster:${fpCount + 1}`);
    }
  }

  if (userId) {
    const sessionsRes = await db.query(
      `SELECT start_time, end_time
       FROM mining_sessions
       WHERE user_id = $1
         AND is_completed = TRUE
       ORDER BY start_time DESC
       LIMIT $2`,
      [userId, cfg.botPatternLookback]
    );

    const pattern = detectBotPattern(sessionsRes.rows || []);
    if (pattern.suspicious) {
      risk += 2;
      reasons.push(...pattern.reasons);
    }
  }

  return { risk, reasons };
}

async function validateHeartbeat(db, sessionRow) {
  const cfg = config();
  const now = Date.now();
  const startMs = new Date(sessionRow?.start_time || Date.now()).getTime();
  const hbMs = new Date(sessionRow?.last_heartbeat || sessionRow?.start_time || Date.now()).getTime();
  const gapMs = now - hbMs;
  const elapsedMs = now - startMs;

  if (gapMs > cfg.heartbeatMaxGapMinutes * 60 * 1000) {
    throw new Error('Session invalid due to inactivity');
  }

  if (elapsedMs >= 6 * 60 * 60 * 1000) {
    const hbCount = Number(sessionRow?.heartbeat_count || 0);
    if (hbCount < cfg.heartbeatMinRequired) {
      throw new Error('Session invalid due to insufficient heartbeat activity');
    }
  }
}

module.exports = {
  config,
  normalizeSecurityFlags,
  extractSecuritySignals,
  evaluateSecuritySignals,
  ensureAntiAbuseSchema,
  logAudit,
  addRisk,
  validateDeviceLimit,
  validateFingerprintLimit,
  detectBotPattern,
  evaluateRisk,
  validateHeartbeat,
};
