const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { extractSecuritySignals, logAudit } = require('../services/antiAbuse');
require('dotenv').config();

const SECRET = process.env.JWT_SECRET;
const PRESENCE_TOUCH_INTERVAL_MINUTES = Math.max(
  1,
  Number(process.env.PRESENCE_TOUCH_INTERVAL_MINUTES || 1)
);
const AUTH_DB_WAITING_THRESHOLD = Math.max(
  2,
  Number(process.env.AUTH_DB_WAITING_THRESHOLD || 12)
);
const AUTH_VERIFICATION_CACHE_MS = Math.max(
  3000,
  Number(process.env.AUTH_VERIFICATION_CACHE_MS || 600000)
);
const AUTH_VERIFICATION_CACHE_MAX_KEYS = Math.max(
  500,
  Number(process.env.AUTH_VERIFICATION_CACHE_MAX_KEYS || 50000)
);
const AUTH_REJECT_AUDIT_ENABLED = String(process.env.AUTH_REJECT_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
const PRESENCE_TOUCH_MIN_INTERVAL_MS = Math.max(
  15000,
  Number(process.env.PRESENCE_TOUCH_MIN_INTERVAL_MS || 60000)
);
const localPresenceTouchMap = new Map();
const authVerificationCache = new Map();

function buildTokenCacheKey(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function getCachedVerificationByToken(token) {
  const key = buildTokenCacheKey(token);
  const cached = authVerificationCache.get(key);
  if (!cached) {
    return null;
  }
  if (cached.expiresAt <= Date.now()) {
    authVerificationCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCachedVerificationByToken(token, payload) {
  const key = buildTokenCacheKey(token);
  authVerificationCache.set(key, {
    payload,
    expiresAt: Date.now() + AUTH_VERIFICATION_CACHE_MS,
  });

  if (authVerificationCache.size > AUTH_VERIFICATION_CACHE_MAX_KEYS) {
    const oldestKey = authVerificationCache.keys().next().value;
    if (oldestKey) {
      authVerificationCache.delete(oldestKey);
    }
  }
}

function primeAuthVerificationCache(token, payload) {
  if (!token || !payload?.userId || !payload?.sessionNonce) {
    return;
  }

  setCachedVerificationByToken(token, {
    userId: payload.userId,
    sessionNonce: payload.sessionNonce,
    device_id: payload.device_id || null,
    device_fingerprint: payload.device_fingerprint || null,
  });
}

async function touchUserPresence(userId) {
  if (!userId) {
    return;
  }

  const now = Date.now();
  const key = String(userId);
  const lastTouchedAt = Number(localPresenceTouchMap.get(key) || 0);
  if ((now - lastTouchedAt) < PRESENCE_TOUCH_MIN_INTERVAL_MS) {
    return;
  }
  localPresenceTouchMap.set(key, now);

  if (localPresenceTouchMap.size > 50000) {
    const oldestKey = localPresenceTouchMap.keys().next().value;
    if (oldestKey) {
      localPresenceTouchMap.delete(oldestKey);
    }
  }

  // Skip presence write under DB pressure — non-critical telemetry
  const waitingCount = Number(db.waitingCount || 0);
  if (Number.isFinite(waitingCount) && waitingCount >= AUTH_DB_WAITING_THRESHOLD) {
    return;
  }

  try {
    await db.query(
      `UPDATE users
       SET last_seen_at = NOW()
       WHERE id = $1
         AND (
           last_seen_at IS NULL
           OR last_seen_at < NOW() - ($2::int * INTERVAL '1 minute')
         )`,
      [userId, PRESENCE_TOUCH_INTERVAL_MINUTES]
    );
  } catch (_) {
    // Presence updates should never block authenticated requests.
  }
}

async function deny(req, reply, reason, userId = null) {
  if (AUTH_REJECT_AUDIT_ENABLED) {
    try {
      await logAudit(db, {
        eventType: 'auth_token_rejected',
        userId,
        ip: req.ip,
        deviceId: String(req.headers['x-device-id'] || '').trim() || null,
        deviceFingerprint: String(req.headers['x-device-fingerprint'] || '').trim() || null,
        details: { reason },
      });
    } catch (_) {
      // Fail closed even if audit logging is unavailable.
    }
  }
  return reply.code(401).send({ error: reason });
}

function isDbConnectTimeoutError(err) {
  const message = String(err && err.message ? err.message : '').toLowerCase();
  return message.includes('timeout exceeded when trying to connect');
}

function isDbPressureHigh() {
  const waitingCount = Number(db.waitingCount || 0);
  const idleCount = Number(db.idleCount || 0);
  const totalCount = Number(db.totalCount || 0);

  if (!Number.isFinite(waitingCount) || waitingCount < AUTH_DB_WAITING_THRESHOLD) {
    return false;
  }

  // Treat as hard pressure only when the pool is fully occupied.
  return idleCount <= 0 && totalCount > 0;
}

function allowsTokenOnlyFallbackOnDbPressure(req) {
  return req?.routeOptions?.config?.allowTokenOnlyAuthOnDbPressure === true;
}

function validateDeviceSignals(decoded, userLike, signals) {
  if (decoded.deviceId && signals.deviceId !== decoded.deviceId) {
    return false;
  }

  if (decoded.deviceFingerprint && signals.deviceFingerprint !== decoded.deviceFingerprint) {
    return false;
  }

  if (userLike.device_id && signals.deviceId !== userLike.device_id) {
    return false;
  }

  if (userLike.device_fingerprint && signals.deviceFingerprint !== userLike.device_fingerprint) {
    return false;
  }

  return true;
}

async function verifyToken(req, reply) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return deny(req, reply, 'No token provided');
    }

    /// Expect format: Bearer TOKEN
    const token = authHeader.split(" ")[1];

    if (!token) {
      return deny(req, reply, 'Invalid token format');
    }

    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    const signals = extractSecuritySignals(req);

    if (!decoded?.userId || !decoded?.sessionNonce) {
      return deny(req, reply, 'Session expired. Please login again.', decoded?.userId || null);
    }

    const tokenDeviceView = {
      device_id: decoded.deviceId || null,
      device_fingerprint: decoded.deviceFingerprint || null,
    };

    if (!validateDeviceSignals(decoded, tokenDeviceView, signals)) {
      return deny(req, reply, 'Device verification failed. Please login again.', decoded.userId);
    }

    if (isDbPressureHigh()) {
      const cached = getCachedVerificationByToken(token);
      if (cached
        && cached.userId === decoded.userId
        && cached.sessionNonce === decoded.sessionNonce
        && validateDeviceSignals(decoded, cached, signals)
      ) {
        req.user = decoded;
        return;
      }

      if (allowsTokenOnlyFallbackOnDbPressure(req)) {
        req.user = decoded;
        return;
      }

      return reply.code(503).send({ error: 'Service busy, please retry.' });
    }

    let userRes;
    try {
      userRes = await db.query(
        `SELECT id, device_id, device_fingerprint, session_nonce, is_deleted
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [decoded.userId]
      );
    } catch (queryErr) {
      if (isDbConnectTimeoutError(queryErr)) {
        return reply.code(503).send({ error: 'Service busy, please retry.' });
      }
      throw queryErr;
    }

    const user = userRes.rows[0];
    if (!user || Boolean(user.is_deleted)) {
      return deny(req, reply, 'Unauthorized', decoded.userId);
    }

    if (!user.session_nonce || user.session_nonce !== decoded.sessionNonce) {
      return deny(req, reply, 'Session expired. Please login again.', decoded.userId);
    }

    if (!validateDeviceSignals(decoded, user, signals)) {
      return deny(req, reply, 'Device verification failed. Please login again.', decoded.userId);
    }

    setCachedVerificationByToken(token, {
      userId: user.id,
      sessionNonce: user.session_nonce,
      device_id: user.device_id || null,
      device_fingerprint: user.device_fingerprint || null,
    });

    /// attach user to request
    req.user = decoded;
    void touchUserPresence(decoded.userId);

  } catch (err) {
    if (isDbConnectTimeoutError(err)) {
      return reply.code(503).send({ error: 'Service busy, please retry.' });
    }
    return deny(req, reply, 'Unauthorized');
  }
}

module.exports = verifyToken;
module.exports.primeAuthVerificationCache = primeAuthVerificationCache;