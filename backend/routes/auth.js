const db = require('../db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');
const nodemailer = require('nodemailer');
const verifyToken = require('../middleware/auth');
const { ANTS_PER_ANET, antsToAnet } = require('../services/miningEngine');
const { ANTS_PER_SESSION, OTP_EXPIRY_MINUTES, OTP_MAX_ATTEMPTS } = require('../constants/economics');
const { t, normalizeLang } = require('../utils/i18n');
const { isValidOtp, sanitizeText } = require('../utils/validation');
const { createWallet, generateCustomWalletAddress, isValidANETWallet, mnemonicToEvm, evmPrivKeyToSecpAnetAddress, evmPrivKeyToLegacyAnetAddress, signAnetActionAuth, seedToPrivateKey } = require('../utils/walletUtils');
const { encryptSecret, decryptSecret, decryptSecretEx, encryptWithPin, decryptWithPin } = require('../utils/cryptoVault');
const {
  ensureAntiAbuseSchema,
  evaluateRisk,
  evaluateSecuritySignals,
  addRisk,
  logAudit,
} = require('../services/antiAbuse');
require('dotenv').config();

const SECRET = process.env.JWT_SECRET;
// OTP is valid for 24 hours by default; same code works for any purpose (login, register, reset, etc.)
const OTP_TTL_MINUTES = Number(process.env.EMAIL_OTP_TTL_MINUTES || 1440);
// Minimum minutes between OTP sends for the same account (prevents email spam on resend)
const OTP_RESEND_COOLDOWN_MINUTES = Number(process.env.OTP_RESEND_COOLDOWN_MINUTES || OTP_TTL_MINUTES);
const OTP_DEBUG_MODE = String(process.env.EMAIL_OTP_DEBUG || 'false').toLowerCase() === 'true';
if (OTP_DEBUG_MODE && String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
  throw new Error('[Security] EMAIL_OTP_DEBUG must not be enabled in production');
}
const LOGIN_DEVICE_OTP_REQUIRED =
  String(process.env.LOGIN_DEVICE_OTP_REQUIRED || 'false').toLowerCase() === 'true';
const SEED_OTP_REQUIRED = String(process.env.SEED_VIEW_OTP_REQUIRED || 'true').toLowerCase() !== 'false';
const PIN_RESET_TTL_MINUTES = Number(process.env.PIN_RESET_OTP_TTL_MINUTES || 10);
const ACCOUNT_DELETE_DELAY_DAYS = Number(process.env.ACCOUNT_DELETE_DELAY_DAYS || 7);
const REGISTER_IP_WINDOW_MAX_ACCOUNTS = Math.max(
  0,
  Number(process.env.REGISTER_IP_WINDOW_MAX_ACCOUNTS || 0)
);
const REGISTER_DEVICE_WINDOW_MAX_ACCOUNTS = Math.max(
  0,
  Number(process.env.REGISTER_DEVICE_WINDOW_MAX_ACCOUNTS || 20)
);
const DEVICE_MAX_ACCOUNTS = Math.max(
  1,
  Number(process.env.DEVICE_MAX_ACCOUNTS || 2)
);
const REGISTER_DEVICE_HARD_BLOCK =
  String(process.env.REGISTER_DEVICE_HARD_BLOCK || 'false').toLowerCase() === 'true';
const GROUP_CHAT_MAX_MESSAGE_LENGTH = Math.max(
  120,
  Number(process.env.GROUP_CHAT_MAX_MESSAGE_LENGTH || 500)
);
const GROUP_CHAT_FETCH_LIMIT = Math.min(
  100,
  Math.max(20, Number(process.env.GROUP_CHAT_FETCH_LIMIT || 60))
);

function isDbConnectTimeoutError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('timeout exceeded when trying to connect') || message.includes('timed out');
}
const REFERRAL_ROOM_NAME_OPTIONS = [
  'Swarm Ants',
  'Queen Ant',
  'Nurse Ants',
  'Farmer Ants',
  'Builder Ants',
  'Scout Ants',
  'Soldier Ants',
  'Worker Ants',
];
const AUTH_READ_CACHE_MS = Math.max(500, Number(process.env.AUTH_READ_CACHE_MS || 15000));
const AUTH_READ_CACHE_STALE_MS = Math.max(5000, Number(process.env.AUTH_READ_CACHE_STALE_MS || 300000));
const AUTH_READ_CACHE_MAX_KEYS = Math.max(200, Number(process.env.AUTH_READ_CACHE_MAX_KEYS || 5000));
const authReadCache = new Map();
const authReadInflight = new Map();

function isValidPin(pin) {
  return /^\d{4,8}$/.test(String(pin || ''));
}

function buildAuthReadCacheKey(userId, route, variant = '') {
  return `${Number(userId) || 0}:${route}:${String(variant || '')}`;
}

function clearAuthReadCacheForUser(userId) {
  const prefix = `${Number(userId) || 0}:`;
  for (const key of authReadCache.keys()) {
    if (key.startsWith(prefix)) {
      authReadCache.delete(key);
    }
  }
  for (const key of authReadInflight.keys()) {
    if (key.startsWith(prefix)) {
      authReadInflight.delete(key);
    }
  }
}

async function getOrLoadAuthReadCache(key, loader) {
  const now = Date.now();
  const cached = authReadCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.payload;
  }

  const stalePayload = cached && cached.staleUntil > now ? cached.payload : null;

  if (cached && cached.staleUntil <= now) {
    authReadCache.delete(key);
  }

  if (authReadInflight.has(key)) {
    return authReadInflight.get(key);
  }

  const inflightPromise = (async () => {
    try {
      const payload = await loader();
      authReadCache.set(key, {
        payload,
        expiresAt: Date.now() + AUTH_READ_CACHE_MS,
        staleUntil: Date.now() + AUTH_READ_CACHE_MS + AUTH_READ_CACHE_STALE_MS,
      });

      if (authReadCache.size > AUTH_READ_CACHE_MAX_KEYS) {
        const oldestKey = authReadCache.keys().next().value;
        if (oldestKey) {
          authReadCache.delete(oldestKey);
        }
      }

      return payload;
    } catch (err) {
      if (stalePayload) {
        return stalePayload;
      }
      throw err;
    }
  })().finally(() => {
    authReadInflight.delete(key);
  });

  authReadInflight.set(key, inflightPromise);
  return inflightPromise;
}

const COUNTRY_BY_CODE = {
  US: 'USA',
  CA: 'Canada',
  BR: 'Brazil',
  GB: 'UK',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NG: 'Nigeria',
  ZA: 'South Africa',
  EG: 'Egypt',
  KE: 'Kenya',
  IN: 'India',
  PK: 'Pakistan',
  BD: 'Bangladesh',
  CN: 'China',
  JP: 'Japan',
  KR: 'South Korea',
  ID: 'Indonesia',
  PH: 'Philippines',
  AU: 'Australia',
  NZ: 'New Zealand',
  AE: 'UAE',
  SA: 'Saudi Arabia',
  TR: 'Turkey',
  MX: 'Mexico',
  AR: 'Argentina',
  CO: 'Colombia',
  VN: 'Vietnam',
  TH: 'Thailand',
};

function normalizeEmailFrom(value) {
  const fallback = 'A-Network <no-reply@mail.a-network.net>';
  const raw = String(value || '').trim();
  if (!raw) return fallback;

  // Already valid: Name <email@domain> or email@domain
  const strictPattern = /^(?:[^<>]+\s*)?<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;
  if (strictPattern.test(raw)) {
    return raw;
  }

  // Recover common mistake: "Name email@domain.com" -> "Name <email@domain.com>"
  const parts = raw.split(/\s+/);
  const maybeEmail = parts[parts.length - 1];
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailPattern.test(maybeEmail)) {
    const name = parts.slice(0, -1).join(' ').trim() || 'A-Network';
    return `${name} <${maybeEmail}>`;
  }

  return fallback;
}

function extractEmailAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const match = raw.match(/<([^>]+)>/);
  return String(match ? match[1] : raw).trim().toLowerCase();
}

const EMAIL_FROM = normalizeEmailFrom(process.env.EMAIL_FROM);
const EMAIL_REPLY_TO = String(
  process.env.EMAIL_REPLY_TO || process.env.EMAIL_SUPPORT_REPLY_TO || 'info@a-network.net'
).trim();
const RESEND_LOG_EMAIL_EVENTS = String(process.env.RESEND_LOG_EMAIL_EVENTS || 'true').toLowerCase() !== 'false';
const SMTP_PROVIDER = String(process.env.SMTP_PROVIDER || '').trim().toLowerCase();
const EMAIL_PROVIDER = SMTP_PROVIDER || 'auto';

const emailFromAddress = extractEmailAddress(EMAIL_FROM);
const emailReplyToAddress = extractEmailAddress(EMAIL_REPLY_TO);
const EMAIL_ALLOWED_FROM_DOMAINS = String(
  process.env.EMAIL_ALLOWED_FROM_DOMAINS || 'mail.a-network.net,a-network.net'
)
  .split(',')
  .map((v) => v.trim().toLowerCase().replace(/^@/, ''))
  .filter(Boolean);

function isAllowedSenderDomain(emailAddress) {
  const senderDomain = String(emailAddress || '').split('@').pop()?.toLowerCase() || '';
  if (!senderDomain) return false;
  return EMAIL_ALLOWED_FROM_DOMAINS.some(
    (allowed) => senderDomain === allowed || senderDomain.endsWith(`.${allowed}`)
  );
}

if (RESEND_LOG_EMAIL_EVENTS) {
  console.info(
    `[Email] Sender configured from=${emailFromAddress || 'invalid'} replyTo=${emailReplyToAddress || 'invalid'} provider=${EMAIL_PROVIDER}`
  );
  if (EMAIL_PROVIDER !== 'gmail' && !isAllowedSenderDomain(emailFromAddress)) {
    console.warn(
      `[Email] EMAIL_FROM is not using an authenticated sender domain (${EMAIL_ALLOWED_FROM_DOMAINS.join(', ')}): ${emailFromAddress || 'invalid'}`
    );
  }
}

function maskEmailAddress(value) {
  const raw = String(value || '').trim().toLowerCase();
  const atIndex = raw.indexOf('@');
  if (atIndex <= 0) {
    return raw || 'unknown';
  }

  const local = raw.slice(0, atIndex);
  const domain = raw.slice(atIndex + 1);
  const visibleLocal = local.length <= 2
    ? `${local[0] || '*'}*`
    : `${local.slice(0, 2)}***`;

  const dotIndex = domain.indexOf('.');
  const domainName = dotIndex === -1 ? domain : domain.slice(0, dotIndex);
  const domainSuffix = dotIndex === -1 ? '' : domain.slice(dotIndex);
  const visibleDomain = domainName.length <= 2
    ? `${domainName[0] || '*'}*`
    : `${domainName.slice(0, 2)}***`;

  return `${visibleLocal}@${visibleDomain}${domainSuffix}`;
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function toClientSafeInt(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value;
  }

  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isSafeInteger(parsed)) {
    return parsed;
  }

  return value;
}

async function issueSession(user, options = {}) {
  const normalizedDeviceId = String(
    options.deviceId || user.device_id || options.headerDeviceId || ''
  ).trim() || null;
  const normalizedFingerprint = String(
    options.deviceFingerprint || user.device_fingerprint || ''
  ).trim() || null;
  const sessionNonce = crypto.randomBytes(24).toString('hex');

  const updatedUserRes = await db.query(
    `UPDATE users
     SET session_nonce = $1,
         device_id = COALESCE($2, device_id),
         device_fingerprint = COALESCE($3, device_fingerprint),
         last_seen_at = NOW(),
         updated_at = NOW()
     WHERE id = $4
     RETURNING id, email, email_verified, wallet_address, balance, ant_balance, ants_balance,
               ads_active, supporter_badge, supporter_since, total_ad_impressions,
               device_id, device_fingerprint, session_nonce`,
    [sessionNonce, normalizedDeviceId, normalizedFingerprint, user.id]
  );

  const boundUser = updatedUserRes.rows[0] || {
    ...user,
    device_id: normalizedDeviceId,
    device_fingerprint: normalizedFingerprint,
    session_nonce: sessionNonce,
  };

  const token = jwt.sign({
    userId: boundUser.id,
    deviceId: boundUser.device_id || null,
    deviceFingerprint: boundUser.device_fingerprint || null,
    sessionNonce: boundUser.session_nonce,
  }, SECRET, { expiresIn: '7d' });

  if (typeof verifyToken.primeAuthVerificationCache === 'function') {
    verifyToken.primeAuthVerificationCache(token, {
      userId: boundUser.id,
      sessionNonce: boundUser.session_nonce,
      device_id: boundUser.device_id || null,
      device_fingerprint: boundUser.device_fingerprint || null,
    });
  }

  const appBalanceAnts = Math.max(
    Number(boundUser.ants_balance || 0),
    Number(boundUser.ant_balance || 0)
  );

  return {
    token,
    user: {
      id: toClientSafeInt(boundUser.id),
      email: boundUser.email,
      emailVerified: !!boundUser.email_verified,
      walletAddress: boundUser.wallet_address || null,
      hasWallet: !!boundUser.wallet_address,
      anetBalance: Number(boundUser.balance || 0),
      appBalanceAnts,
      appBalance: antsToAnet(appBalanceAnts),
      adsActive: boundUser.ads_active !== false,
      supporterBadge: Boolean(boundUser.supporter_badge),
      supporterSince: boundUser.supporter_since || null,
      totalAdImpressions: Number(boundUser.total_ad_impressions || 0),
    },
  };
}

async function enforceSecureRuntime(req, reply, options = {}) {
  const {
    eventType,
    userId = null,
    email = null,
    deviceId = null,
    deviceFingerprint = null,
    responseType = 'error',
  } = options;

  const securityEval = evaluateSecuritySignals(req, {
    deviceFingerprint,
  });

  if (!securityEval.shouldBlock) {
    return { blocked: false, securityEval };
  }

  await logAudit(db, {
    eventType,
    userId,
    ip: req.ip,
    deviceId: deviceId || securityEval.deviceId || null,
    deviceFingerprint: deviceFingerprint || securityEval.deviceFingerprint || null,
    riskPoints: securityEval.risk,
    details: {
      reasons: securityEval.reasons,
      email: email || null,
    },
  });

  const payload = responseType === 'message'
    ? { success: false, message: securityEval.blockReason }
    : { error: securityEval.blockReason };

  return {
    blocked: true,
    securityEval,
    response: reply.code(403).send(payload),
  };
}

function sanitizeMigrationAddress(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) {
    return null;
  }

  if (!isValidANETWallet(raw)) {
    return null;
  }

  return raw;
}

async function ensureMigrationWalletAvailable(address, userId) {
  if (!address) {
    return true;
  }

  const existingRes = await db.query(
    `SELECT id
     FROM users
     WHERE id <> $2
       AND (
         wallet_address = $1
         OR custom_wallet_address = $1
         OR migration_wallet_address = $1
       )
     LIMIT 1`,
    [address, userId]
  );

  return !existingRes.rows[0];
}

async function ensureOtpSchema() {
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS country VARCHAR(80) DEFAULT 'Unknown'
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referral_code VARCHAR(32)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referred_by INT
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referral_first_session_rewarded BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42)
  `);

  await db.query(`
    ALTER TABLE users
    ALTER COLUMN wallet_address TYPE VARCHAR(120)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_passphrase TEXT
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS balance NUMERIC(20, 8) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ant_balance NUMERIC(30, 0) DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ALTER COLUMN ant_balance TYPE NUMERIC(30, 0)
    USING ROUND(COALESCE(ant_balance, 0))
  `);

  await db.query(`
    ALTER TABLE users
    ALTER COLUMN ant_balance SET DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS custom_wallet_address VARCHAR(80)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS migration_wallet_address VARCHAR(120)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_validator_candidate BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS validator_status VARCHAR(50) DEFAULT 'MINER'
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS validator_key TEXT
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS validator_joined_at TIMESTAMP
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS validator_reputation INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE network_stats
    ADD COLUMN IF NOT EXISTS total_mined_ants NUMERIC(30, 0) DEFAULT 0
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet_address_unique
    ON users(wallet_address)
    WHERE wallet_address IS NOT NULL
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_custom_wallet_address_unique
    ON users(custom_wallet_address)
    WHERE custom_wallet_address IS NOT NULL
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_unique
    ON users(referral_code)
    WHERE referral_code IS NOT NULL
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_otp_codes (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      purpose VARCHAR(32) NOT NULL DEFAULT 'register',
      code_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_otp_lookup
    ON email_otp_codes(email, purpose, used_at, expires_at)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS total_sessions BIGINT DEFAULT 0 CHECK (total_sessions >= 0)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS progress_percent DOUBLE PRECISION DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 100)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_session_time TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS session_end_time TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS notification_sent BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ants_balance BIGINT DEFAULT 0 CHECK (ants_balance >= 0)
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_eligible BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pin_hash TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS otp_code TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS otp_expiry TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS otp_attempts INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_trusted_device BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS device_fingerprint TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS session_nonce TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT 'en' NOT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ads_enabled BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ads_enabled_at TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ads_last_active_at TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ads_active BOOLEAN DEFAULT TRUE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ads_started_at TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS ads_last_seen_at TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS supporter_badge BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS supporter_since TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS total_ad_sessions INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS total_ad_impressions INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD CONSTRAINT users_total_ad_sessions_non_negative CHECK (total_ad_sessions >= 0)
  `).catch(() => null);

  await db.query(`
    ALTER TABLE users
    ADD CONSTRAINT users_total_ad_impressions_non_negative CHECK (total_ad_impressions >= 0)
  `).catch(() => null);

  await db.query(`
    UPDATE users
    SET ads_active = COALESCE(ads_active, COALESCE(ads_enabled, TRUE)),
        ads_started_at = COALESCE(ads_started_at, ads_enabled_at, created_at, NOW()),
        ads_last_seen_at = COALESCE(ads_last_seen_at, ads_last_active_at),
        total_ad_impressions = GREATEST(COALESCE(total_ad_impressions, 0), COALESCE(total_ad_sessions, 0))
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_seed_encrypted TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_seed_iv TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS wallet_seed_tag TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS seed_view_otp_hash TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS seed_view_otp_expiry TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS seed_view_otp_attempts INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pin_reset_otp_hash TEXT NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pin_reset_otp_expiry TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pin_reset_otp_attempts INTEGER DEFAULT 0
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deletion_scheduled_for TIMESTAMP NULL
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deletion_restore_used BOOLEAN DEFAULT FALSE
  `);

  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS deletion_restored_at TIMESTAMP NULL
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_users_session_end_time ON users(session_end_time)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_notification_sent ON users(notification_sent)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_ads_active ON users(ads_active)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_ads_started_at ON users(ads_started_at)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_users_supporter_badge ON users(supporter_badge)');

  await db.query(`
    CREATE TABLE IF NOT EXISTS referral_group_messages (
      id BIGSERIAL PRIMARY KEY,
      room_key VARCHAR(32) NOT NULL DEFAULT 'qualified-referrals',
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_text VARCHAR(500) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS referral_chat_rooms (
      room_key VARCHAR(32) PRIMARY KEY,
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_name VARCHAR(80) NOT NULL DEFAULT 'Worker Ants',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query('ALTER TABLE users ALTER COLUMN id TYPE BIGINT');
  await db.query('ALTER TABLE users ALTER COLUMN referred_by TYPE BIGINT');
  await db.query('ALTER TABLE users ALTER COLUMN successful_sessions TYPE BIGINT');
  await db.query('ALTER TABLE users ALTER COLUMN total_sessions TYPE BIGINT');
  await db.query('ALTER TABLE email_otp_codes ALTER COLUMN id TYPE BIGINT');
  await db.query('ALTER TABLE email_otp_codes ALTER COLUMN user_id TYPE BIGINT');
  await db.query('ALTER TABLE referral_group_messages ALTER COLUMN user_id TYPE BIGINT');
  await db.query('ALTER TABLE referral_chat_rooms ALTER COLUMN owner_user_id TYPE BIGINT');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_referral_group_messages_room_time
    ON referral_group_messages(room_key, created_at DESC)
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_chat_rooms_owner
    ON referral_chat_rooms(owner_user_id)
  `);

  await db.query(`
    ALTER TABLE referral_chat_rooms
    ADD COLUMN IF NOT EXISTS room_name VARCHAR(80) NOT NULL DEFAULT 'Worker Ants'
  `);

  await db.query(`
    WITH completed AS (
      SELECT user_id, COUNT(*)::bigint AS completed_sessions
      FROM mining_sessions
      WHERE is_completed = TRUE
        AND (status IS NULL OR status = 'completed')
      GROUP BY user_id
    )
    UPDATE users u
    SET successful_sessions = GREATEST(
          COALESCE(u.successful_sessions, 0),
          COALESCE(completed.completed_sessions, 0)
        ),
        total_sessions = GREATEST(
          COALESCE(u.total_sessions, 0),
          COALESCE(completed.completed_sessions, 0)
        ),
        ants_balance = GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint),
        progress_percent = LEAST(
          100,
          (
            GREATEST(
              COALESCE(u.successful_sessions, 0),
              COALESCE(completed.completed_sessions, 0)
            )::double precision / 1000.0
          ) * 100.0
        ),
        is_eligible = (
          GREATEST(
            COALESCE(u.successful_sessions, 0),
            COALESCE(completed.completed_sessions, 0)
          ) >= 1000
        )
    FROM completed
    WHERE completed.user_id = u.id
  `);

  // claimed_anet: tracks how much a user has claimed/bridged to BSC
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS claimed_anet NUMERIC(30, 8) DEFAULT 0
  `);

  // PIN-encrypted wallet seed columns (migration 002)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN DEFAULT FALSE`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_seed_pin_encrypted TEXT NULL`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_seed_pin_iv TEXT NULL`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_seed_pin_tag TEXT NULL`);

  // Performance index for the per-request last_seen_at UPDATE in auth middleware
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_users_id_last_seen
    ON users (id, last_seen_at)
    WHERE last_seen_at IS NOT NULL
  `);

  // AdMob SSV deduplication table + AI token balance (migrate_ssv)
  await db.query(`
    CREATE TABLE IF NOT EXISTS ssv_transactions (
      id             BIGSERIAL PRIMARY KEY,
      transaction_id VARCHAR(512) UNIQUE NOT NULL,
      user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ad_unit_id     VARCHAR(256),
      reward_amount  INT NOT NULL DEFAULT 8,
      reward_item    VARCHAR(64) NOT NULL DEFAULT 'AI_TOKEN',
      received_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ssv_transactions_user_id ON ssv_transactions (user_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ssv_transactions_received_at ON ssv_transactions (received_at DESC)`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_token_balance INT NOT NULL DEFAULT 20`);

  // Push notification token (migration_prod_session_i18n_v1_0_3)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS device_token TEXT NULL`);

  // EVM connected address (chatbot feature)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_connected_address VARCHAR(42) NULL`);

  // Last activity timestamp (admin dashboard queries)
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP NULL`);
}

async function repairUserSessionLedger(userId) {
  await db.query(
    `WITH completed AS (
       SELECT COUNT(*)::bigint AS completed_sessions
       FROM mining_sessions
       WHERE user_id = $1
         AND is_completed = TRUE
         AND COALESCE(status, '') = 'completed'
     )
     UPDATE users u
     SET successful_sessions = LEAST(
           COALESCE(u.successful_sessions, 0),
           COALESCE(completed.completed_sessions, COALESCE(u.successful_sessions, 0))
         ),
         total_sessions = LEAST(
           COALESCE(u.total_sessions, 0),
           COALESCE(completed.completed_sessions, COALESCE(u.total_sessions, 0))
         ),
         ants_balance = GREATEST(COALESCE(u.ants_balance, 0), COALESCE(u.ant_balance, 0)::bigint),
         ant_balance = GREATEST(COALESCE(u.ant_balance, 0), COALESCE(u.ants_balance, 0)::numeric),
         progress_percent = LEAST(
           100,
           (
             LEAST(
               COALESCE(u.total_sessions, 0),
               COALESCE(completed.completed_sessions, COALESCE(u.total_sessions, 0))
             )::double precision / 1000.0
           ) * 100.0
         ),
         is_eligible = (
           LEAST(
             COALESCE(u.total_sessions, 0),
             COALESCE(completed.completed_sessions, COALESCE(u.total_sessions, 0))
           ) >= 1000
         )
     FROM completed
     WHERE u.id = $1`,
    [userId]
  );
}

function buildOtpEmailHtml({ title, bodyLines, otp, previewText = 'Your A-Network verification code' }) {
  const paragraphs = bodyLines
    .map((line) => `<p style="margin:0 0 12px;color:#24303f;font-size:15px;line-height:1.6;">${line}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f3f5f7;font-family:Arial,sans-serif;color:#17212b;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${previewText}</div>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="max-width:520px;background:#ffffff;border:1px solid #d9e0e7;border-radius:10px;">
          <tr>
            <td style="padding:24px 28px 12px;font-size:20px;font-weight:700;color:#101828;">A-Network</td>
          </tr>
          <tr>
            <td style="padding:0 28px 12px;font-size:20px;font-weight:700;color:#101828;">${title}</td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px;">${paragraphs}</td>
          </tr>
          <tr>
            <td style="padding:12px 28px 8px;">
              <div style="display:inline-block;padding:14px 18px;border:1px solid #c8d1dc;border-radius:8px;background:#f8fafc;font-family:'Courier New',monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:#0f172a;">${otp}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 28px 28px;font-size:12px;line-height:1.6;color:#526071;">
              This is a transactional security email from A-Network. If you did not request this code, you can ignore this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildOtpEmailText({ title, bodyLines, otp }) {
  const plainLines = bodyLines.map((line) => htmlToPlainText(line));
  return [
    'A-Network',
    '',
    title,
    '',
    ...plainLines,
    '',
    `Code: ${otp}`,
    '',
    'This is a transactional security email from A-Network.',
    'If you did not request this code, you can ignore this message.',
  ].join('\n');
}

async function sendLoginOtpEmail(email, otp) {
  const subject = 'A-Network: your login verification code';
  const validityText = OTP_TTL_MINUTES >= 60
    ? `${Math.round(OTP_TTL_MINUTES / 60)} hour(s)`
    : `${OTP_TTL_MINUTES} minutes`;
  const bodyLines = [
    'Use the code below to complete your login to A-Network.',
    `This code is valid for <strong>${validityText}</strong> and can be used for any verification request on your account.`,
  ];
  const html = buildOtpEmailHtml({
    title: 'Login Verification',
    bodyLines,
    otp,
    previewText: 'Your A-Network login verification code',
  });
  const text = buildOtpEmailText({ title: 'Login Verification', bodyLines, otp });
  return sendEmail(email, subject, html, text);
}

async function storeLoginOtpRecord(userId, email, otpHash) {
  await db.query(
    `INSERT INTO email_otp_codes (user_id, email, purpose, code_hash, expires_at)
     VALUES ($1, $2, 'login', $3, NOW() + ($4 || ' minutes')::interval)`,
    [userId, email, otpHash, OTP_TTL_MINUTES]
  );
}

async function getLatestLoginOtpRecord(email, userId = null) {
  const rows = await getLatestActiveOtpRecords(email, 'login', userId);
  return rows[0] || null;
}

async function issueLoginOtp(user) {
  // Universal 24-hr OTP: respect cooldown across all purposes
  const existingOtp = await getAnyActiveOtpForUser(user.email, user.id);
  if (existingOtp) {
    const cooldownMs = OTP_RESEND_COOLDOWN_MINUTES * 60 * 1000;
    const issuedAt = new Date(existingOtp.created_at);
    const waitUntil = new Date(issuedAt.getTime() + cooldownMs);
    const now = new Date();

    if (now < waitUntil) {
      const waitSeconds = Math.ceil((waitUntil - now) / 1000);
      const waitMins = Math.ceil(waitSeconds / 60);
      return {
        otp: null,
        otpSent: false,
        otpError: `otp_cooldown:${waitSeconds}`,
        cooldown: true,
        waitSeconds,
        waitMins,
      };
    }

    // Outside cooldown — invalidate all previous active OTPs
    await markAllOtpsUsedForUser(user.email, user.id);
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = await bcrypt.hash(otp, 10);

  await db.query(
    `UPDATE users
     SET otp_code = $1,
         otp_expiry = NOW() + ($2 || ' minutes')::interval,
         otp_attempts = 0
     WHERE id = $3`,
    [otpHash, OTP_TTL_MINUTES, user.id]
  );

  try {
    await storeLoginOtpRecord(user.id, user.email, otpHash);
  } catch (recordErr) {
    console.error('Login OTP record store failed:', recordErr.message || recordErr);
  }

  let otpSent = false;
  let otpError = null;
  try {
    const sendResult = await sendLoginOtpEmail(user.email, otp);
    otpSent = Boolean(sendResult?.sent);
    if (!otpSent) {
      otpError = sendResult?.reason || 'send_failed';
    }
  } catch (sendErr) {
    otpError = sanitizeProviderError(sendErr);
  }

  return {
    otp,
    otpSent,
    otpError,
    cooldown: false,
  };
}

async function backfillAntsLedger() {
  // Phase 1: reconstruct from mining_sessions for users who have sessions.
  // Use reward-sum when available; fall back to session-count × launch rate
  // (4882812 ANTS) for sessions where reward was not persisted (e.g. very early rows).
  // Also include the legacy `balance` ANET column as an additional source.
  await db.query(`
    WITH completed AS (
      SELECT
        ms.user_id,
        COUNT(*)::bigint AS session_count,
        COALESCE(SUM(ROUND(COALESCE(ms.reward, 0) * ${ANTS_PER_ANET})), 0)::bigint AS ants_from_rewards
      FROM mining_sessions ms
      WHERE ms.is_completed = TRUE
        AND COALESCE(ms.status, '') = 'completed'
      GROUP BY ms.user_id
    ),
    best_ants AS (
      SELECT
        c.user_id,
        GREATEST(
          c.ants_from_rewards,
          CASE WHEN c.ants_from_rewards = 0 AND c.session_count > 0
               THEN c.session_count * 4882812
               ELSE 0
          END
        ) AS ants_from_sessions
      FROM completed c
    )
    UPDATE users u
    SET ants_balance = GREATEST(
          COALESCE(u.ants_balance, 0),
          COALESCE(u.ant_balance, 0)::bigint,
          ROUND(COALESCE(u.balance, 0) * ${ANTS_PER_ANET})::bigint,
          COALESCE(b.ants_from_sessions, 0)
        ),
        ant_balance = GREATEST(
          COALESCE(u.ant_balance, 0),
          COALESCE(u.ants_balance, 0)::numeric,
          ROUND(COALESCE(u.balance, 0) * ${ANTS_PER_ANET})::numeric,
          COALESCE(b.ants_from_sessions, 0)
        )
    FROM best_ants b
    WHERE b.user_id = u.id
  `);

  // Phase 2: blanket sync for all users (covers those without sessions but with
  // a legacy balance value, and keeps the two ant columns in sync).
  await db.query(`
    UPDATE users
    SET ants_balance = GREATEST(
          COALESCE(ants_balance, 0),
          COALESCE(ant_balance, 0)::bigint,
          ROUND(COALESCE(balance, 0) * ${ANTS_PER_ANET})::bigint
        ),
        ant_balance = GREATEST(
          COALESCE(ant_balance, 0),
          COALESCE(ants_balance, 0)::numeric,
          ROUND(COALESCE(balance, 0) * ${ANTS_PER_ANET})::numeric
        )
  `);

  await db.query(`
    UPDATE network_stats
    SET total_mined_ants = ROUND(COALESCE(total_mined, 0) * ${ANTS_PER_ANET}),
        total_mined = ROUND(COALESCE(total_mined, 0), 8)
    WHERE total_mined_ants IS NULL
       OR total_mined_ants <> ROUND(COALESCE(total_mined, 0) * ${ANTS_PER_ANET})
  `);

  await db.query(`
    UPDATE network_stats
    SET total_mined = ROUND(COALESCE(total_mined_ants, 0) / ${ANTS_PER_ANET}.0, 8)
    WHERE total_mined IS NULL
       OR total_mined <> ROUND(COALESCE(total_mined_ants, 0) / ${ANTS_PER_ANET}.0, 8)
  `);
}

async function backfillDeterministicCustomWalletAddresses() {
  const usersRes = await db.query(
    `SELECT id, wallet_passphrase, custom_wallet_address
     FROM users
     WHERE wallet_passphrase IS NOT NULL
       AND TRIM(wallet_passphrase) <> ''`
  );

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const row of usersRes.rows) {
    const expected = generateCustomWalletAddress(row.wallet_passphrase);
    const current = String(row.custom_wallet_address || '').trim();

    if (current === expected) {
      unchanged += 1;
      continue;
    }

    try {
      await db.query(
        `UPDATE users
         SET custom_wallet_address = $1
         WHERE id = $2`,
        [expected, row.id]
      );
      updated += 1;
    } catch (err) {
      // Keep service online even if one row conflicts (e.g. rare unique collision).
      skipped += 1;
      console.warn(`[Auth] Skipped deterministic custom wallet update for user ${row.id}: ${err.code || err.message}`);
    }
  }

  console.log(`[Auth] Deterministic custom wallet backfill complete. updated=${updated}, unchanged=${unchanged}, skipped=${skipped}`);
}

async function encryptLegacyWalletSeeds() {
  const rows = await db.query(
    `SELECT id, wallet_passphrase, wallet_seed_encrypted
     FROM users
     WHERE wallet_passphrase IS NOT NULL
       AND TRIM(wallet_passphrase) <> ''
       AND wallet_seed_encrypted IS NULL`
  );

  let migrated = 0;
  for (const row of rows.rows) {
    try {
      const encrypted = encryptSecret(row.wallet_passphrase);
      await db.query(
        `UPDATE users
         SET wallet_seed_encrypted   = $1,
             wallet_seed_iv          = $2,
             wallet_seed_tag         = $3,
             wallet_seed_key_version = 2,
             wallet_passphrase       = NULL
         WHERE id = $4`,
        [encrypted.encrypted, encrypted.iv, encrypted.tag, row.id]
      );
      migrated += 1;
    } catch (err) {
      console.warn(`[Auth] Failed wallet seed encryption migration for user ${row.id}: ${err.message || err}`);
    }
  }

  if (migrated > 0) {
    console.log(`[Auth] Encrypted and migrated ${migrated} legacy wallet seed phrase(s)`);
  }
}

async function sendSimpleOtpEmail(email, otp, subject, title, ttlMinutes) {
  const validityText = ttlMinutes >= 60
    ? `${Math.round(ttlMinutes / 60)} hour(s)`
    : `${ttlMinutes} minutes`;
  const bodyLines = [
    'Use the code below to complete your request on A-Network.',
    `This code is valid for <strong>${validityText}</strong>.`,
  ];
  const html = buildOtpEmailHtml({
    title,
    bodyLines,
    otp,
    previewText: 'Your A-Network security verification code',
  });
  const text = buildOtpEmailText({ title, bodyLines, otp });
  return sendEmail(email, subject, html, text);
}

function normalizeReferralCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function buildReferralCode(userId) {
  return `ANET${Number(userId).toString(36).toUpperCase()}`;
}

function normalizeCommunityRoomScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'my-colony' || normalized === 'upline-colony') {
    return normalized;
  }
  return 'auto';
}

async function ensureUserReferralCode(userId, referralCodeHint = '') {
  const existingCode = String(referralCodeHint || '').trim();
  if (existingCode) {
    return existingCode;
  }

  const generated = buildReferralCode(userId);
  try {
    const updated = await db.query(
      `UPDATE users
       SET referral_code = COALESCE(NULLIF(TRIM(referral_code), ''), $1)
       WHERE id = $2
       RETURNING referral_code`,
      [generated, userId]
    );

    return String(updated.rows[0]?.referral_code || generated).trim() || generated;
  } catch (_) {
    // Never block user-facing reads when referral code persistence is under load.
    return generated;
  }
}

async function getReferralChatContext(userId, preferredScope = 'auto') {
  const meRes = await db.readQuery(
    `SELECT id, email, referral_code, referred_by
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  const me = meRes.rows[0];
  if (!me) {
    throw new Error('User not found');
  }

  const myDirectReferralCountRes = await db.readQuery(
    `SELECT COUNT(*)::int AS total
     FROM users
     WHERE referred_by = $1`,
    [userId]
  );

  const myDirectReferralCount = Number(myDirectReferralCountRes.rows[0]?.total || 0);
  const hasUpline = !!me.referred_by;
  const scope = normalizeCommunityRoomScope(preferredScope);

  let activeScope = 'my-colony';
  if (scope === 'upline-colony' && hasUpline) {
    activeScope = 'upline-colony';
  } else if (scope === 'auto') {
    activeScope = hasUpline && myDirectReferralCount <= 0 ? 'upline-colony' : 'my-colony';
  }

  const roomOwnerId = Number(
    activeScope === 'upline-colony' && hasUpline ? me.referred_by : me.id
  );
  const ownerRes = roomOwnerId === Number(me.id)
    ? { rows: [me] }
    : await db.readQuery(
        `SELECT id, email, referral_code
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [roomOwnerId]
      );

  const owner = ownerRes.rows[0];
  if (!owner) {
    throw new Error('Referral room owner not found');
  }

  const referralCountRes = await db.readQuery(
    `SELECT COUNT(*)::int AS total
     FROM users
     WHERE referred_by = $1`,
    [roomOwnerId]
  );

  const ownerLabel = String(owner.referral_code || owner.email || `User ${roomOwnerId}`).trim();
  const roomKey = `referral-room-${roomOwnerId}`;

  await db.query(
    `INSERT INTO referral_chat_rooms (room_key, owner_user_id, room_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (room_key) DO NOTHING`,
    [roomKey, roomOwnerId, 'Worker Ants']
  );

  const roomRes = await db.query(
    `SELECT room_name
     FROM referral_chat_rooms
     WHERE room_key = $1
     LIMIT 1`,
    [roomKey]
  );
  const roomName = String(roomRes.rows[0]?.room_name || 'Worker Ants').trim();

  return {
    hasUpline,
    canClaimAntCode: !me.referred_by,
    myAntCode: String(me.referral_code || '').trim(),
    roomKey,
    roomOwnerId,
    roomOwnerLabel: ownerLabel,
    roomName,
    isOwner: roomOwnerId === Number(userId),
    currentScope: activeScope,
    availableScopes: [
      { key: 'my-colony', label: 'My Colony' },
      ...(hasUpline ? [{ key: 'upline-colony', label: 'Upline Colony' }] : []),
    ],
    myDirectReferralCount,
    accessRole: roomOwnerId === Number(userId) ? 'owner' : 'referral-member',
    directReferralCount: Number(referralCountRes.rows[0]?.total || 0),
  };
}

async function loadReferralChatMessages(roomKey, limit = GROUP_CHAT_FETCH_LIMIT) {
  const safeLimit = Math.min(
    100,
    Math.max(20, Number(limit) || GROUP_CHAT_FETCH_LIMIT)
  );
  const messagesRes = await db.readQuery(
    `SELECT
       m.id,
       m.message_text,
       m.created_at,
       m.user_id,
       COALESCE(NULLIF(u.referral_code, ''), 'User ' || u.id::text) AS sender_label
     FROM referral_group_messages m
     INNER JOIN users u ON u.id = m.user_id
     WHERE m.room_key = $1
     ORDER BY m.id DESC
     LIMIT $2`,
    [roomKey, safeLimit]
  );

  return messagesRes.rows.reverse().map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    senderLabel: row.sender_label,
    text: row.message_text,
    createdAt: row.created_at,
    isMine: false,
  }));
}

function normalizeCountryCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return c.length == 2 ? c : '';
}

function resolveCountryFromRequest(req) {
  const directName = String(req.headers['x-country'] || req.headers['x-country-name'] || '').trim();
  if (directName) {
    return directName.slice(0, 80);
  }

  const possibleCode = normalizeCountryCode(
    req.headers['cf-ipcountry'] ||
      req.headers['x-vercel-ip-country'] ||
      req.headers['cloudfront-viewer-country'] ||
      req.headers['x-country-code']
  );

  if (!possibleCode) {
    return 'Unknown';
  }

  return COUNTRY_BY_CODE[possibleCode] || possibleCode;
}

function htmlToPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildGmailTransport() {
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_APP_PASSWORD || '').trim();
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

async function sendViaGmail(to, subject, html, text = '') {
  const transport = buildGmailTransport();
  if (!transport) {
    return { sent: false, reason: 'Missing SMTP_USER or SMTP_APP_PASSWORD' };
  }
  const replyToAddress = emailReplyToAddress || emailFromAddress;
  const info = await transport.sendMail({
    from: EMAIL_FROM,
    to,
    replyTo: replyToAddress,
    subject,
    html,
    text: String(text || '').trim() || htmlToPlainText(html),
  });
  if (RESEND_LOG_EMAIL_EVENTS) {
    console.info(
      `[Email] Gmail SMTP accepted messageId=${info.messageId || 'unknown'} to=${maskEmailAddress(to)} subject=${JSON.stringify(subject)}`
    );
  }
  return { sent: true, provider: 'gmail', messageId: info.messageId || null };
}

function sendViaResend(to, subject, html, text = '') {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return Promise.resolve({ sent: false, reason: 'Missing RESEND_API_KEY' });
  }

  const replyToAddress = emailReplyToAddress || emailFromAddress;

  const payload = JSON.stringify({
    from: EMAIL_FROM,
    to: [to],
    reply_to: replyToAddress,
    subject,
    html,
    text: String(text || '').trim() || htmlToPlainText(html),
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const parsed = parseJsonSafe(data);
          const providerMessageId = parsed?.id || parsed?.data?.id || null;

          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (RESEND_LOG_EMAIL_EVENTS) {
              console.info(
                `[Email] Resend accepted messageId=${providerMessageId || 'unknown'} to=${maskEmailAddress(to)} status=${res.statusCode} subject=${JSON.stringify(subject)}`
              );
            }
            resolve({
              sent: true,
              provider: 'resend',
              messageId: providerMessageId,
              statusCode: res.statusCode,
            });
            return;
          }

          const details = typeof data === 'string' ? data.trim().slice(0, 500) : '';
          if (RESEND_LOG_EMAIL_EVENTS) {
            console.error(
              `[Email] Resend rejected to=${maskEmailAddress(to)} status=${res.statusCode} subject=${JSON.stringify(subject)} body=${details || 'empty'}`
            );
          }
          reject(new Error(`Resend failed (${res.statusCode}): ${details || 'Unknown provider response'}`));
        });
      }
    );

    req.on('error', (err) => {
      if (RESEND_LOG_EMAIL_EVENTS) {
        console.error(
          `[Email] Resend request error to=${maskEmailAddress(to)} subject=${JSON.stringify(subject)}: ${err.message || err}`
        );
      }
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

async function sendEmail(to, subject, html, text = '') {
  const provider = String(process.env.SMTP_PROVIDER || '').trim().toLowerCase() || 'auto';

  if (provider === 'resend') {
    return sendViaResend(to, subject, html, text);
  }

  if (provider === 'gmail') {
    try {
      const gmailResult = await sendViaGmail(to, subject, html, text);
      if (gmailResult?.sent) {
        return gmailResult;
      }
      if (RESEND_LOG_EMAIL_EVENTS) {
        console.warn(
          `[Email] Gmail send skipped or failed (${gmailResult?.reason || 'unknown'}). Falling back to Resend.`
        );
      }
    } catch (err) {
      if (RESEND_LOG_EMAIL_EVENTS) {
        console.warn(
          `[Email] Gmail send error (${err?.message || err}). Falling back to Resend.`
        );
      }
    }
    return sendViaResend(to, subject, html, text);
  }

  // auto mode (default): Resend first for scale/reputation, then Gmail fallback.
  try {
    const resendResult = await sendViaResend(to, subject, html, text);
    if (resendResult?.sent) {
      return resendResult;
    }
    if (RESEND_LOG_EMAIL_EVENTS) {
      console.warn(
        `[Email] Resend skipped or failed (${resendResult?.reason || 'unknown'}). Falling back to Gmail SMTP.`
      );
    }
  } catch (err) {
    if (RESEND_LOG_EMAIL_EVENTS) {
      console.warn(
        `[Email] Resend send error (${err?.message || err}). Falling back to Gmail SMTP.`
      );
    }
  }

  return sendViaGmail(to, subject, html, text);
}

async function createAndSendOtp(email, userId, purpose = 'register') {
  // Universal 24-hr OTP: if there is already an active (unexpired, unused) OTP for this
  // account — regardless of purpose — enforce the resend cooldown to prevent email spam.
  const existingOtp = await getAnyActiveOtpForUser(email, userId);
  if (existingOtp) {
    const cooldownMs = OTP_RESEND_COOLDOWN_MINUTES * 60 * 1000;
    const issuedAt = new Date(existingOtp.created_at);
    const waitUntil = new Date(issuedAt.getTime() + cooldownMs);
    const now = new Date();

    if (now < waitUntil) {
      const waitSeconds = Math.ceil((waitUntil - now) / 1000);
      const waitMins = Math.ceil(waitSeconds / 60);
      return {
        sendResult: { sent: false, reason: `otp_cooldown:${waitSeconds}` },
        otp: null,
        cooldown: true,
        waitSeconds,
        waitMins,
      };
    }

    // Outside cooldown — invalidate all previous active OTPs before issuing new one
    await markAllOtpsUsedForUser(email, userId);
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const hash = await bcrypt.hash(otp, 10);

  await db.query(
    `INSERT INTO email_otp_codes (user_id, email, purpose, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
    [userId, email, purpose, hash, OTP_TTL_MINUTES]
  );

  const ttlDisplay = OTP_TTL_MINUTES >= 60
    ? `${Math.round(OTP_TTL_MINUTES / 60)} hour(s)`
    : `${OTP_TTL_MINUTES} minutes`;

  const isPasswordReset = purpose === 'reset_password';
  const isAccountRestore = purpose === 'restore_account';
  const subject = isPasswordReset
    ? 'Your A-Network password reset code'
    : isAccountRestore
      ? 'Your A-Network account restore code'
      : 'Your A-Network verification code';
  const heading = isPasswordReset
    ? 'A-Network Password Reset'
    : isAccountRestore
      ? 'A-Network Account Restore'
      : 'A-Network Email Verification';
  const intro = isPasswordReset
    ? 'Use this code to reset your password:'
    : isAccountRestore
      ? 'Use this one-time code to restore your scheduled-for-deletion account:'
      : 'Your verification code is:';

  const bodyLines = [
    intro,
    `This code is valid for ${ttlDisplay}. You may use it for any verification request on your account.`,
    ...(isAccountRestore
      ? ['This recovery can only be used once. If you delete your account again, you will not be able to restore it with email OTP.']
      : []),
    'If you did not request this, please ignore this email.',
  ];
  const html = buildOtpEmailHtml({
    title: heading,
    bodyLines,
    otp,
    previewText: subject,
  });
  const text = buildOtpEmailText({
    title: heading,
    bodyLines,
    otp,
  });

  const sendResult = await sendEmail(email, subject, html, text);
  return {
    sendResult,
    otp,
    cooldown: false,
  };
}

async function getLatestActiveOtpRecords(email, purpose, userId = null) {
  const params = [email];
  // purpose = null means any purpose (universal OTP lookup)
  let purposeClause = '';
  if (purpose !== null) {
    params.push(purpose);
    purposeClause = ` AND purpose = $${params.length}`;
  }
  let userClause = '';

  if (userId != null) {
    params.push(userId);
    userClause = ` AND user_id = $${params.length}`;
  }

  const result = await db.query(
    `SELECT id, code_hash, expires_at
     FROM email_otp_codes
     WHERE email = $1
       AND used_at IS NULL
       AND expires_at >= NOW()${purposeClause}${userClause}
     ORDER BY created_at DESC, id DESC
     LIMIT 10`,
    params
  );

  return result.rows;
}

async function findMatchingOtpRecord(email, purpose, plainCode, userId = null) {
  const rows = await getLatestActiveOtpRecords(email, purpose, userId);
  for (const row of rows) {
    if (await bcrypt.compare(plainCode, row.code_hash)) {
      return row;
    }
  }

  return null;
}

async function markOtpRecordsUsed(email, purpose, userId = null) {
  const params = [email];
  let purposeClause = '';
  if (purpose !== null) {
    params.push(purpose);
    purposeClause = ` AND purpose = $${params.length}`;
  }
  let userClause = '';

  if (userId != null) {
    params.push(userId);
    userClause = ` AND user_id = $${params.length}`;
  }

  await db.query(
    `UPDATE email_otp_codes
     SET used_at = NOW()
     WHERE email = $1
       AND used_at IS NULL${purposeClause}${userClause}`,
    params
  );
}

// Mark ALL active OTPs for a user as used (universal — across all purposes)
async function markAllOtpsUsedForUser(email, userId) {
  await db.query(
    `UPDATE email_otp_codes
     SET used_at = NOW()
     WHERE email = $1
       AND user_id = $2
       AND used_at IS NULL`,
    [email, userId]
  );
}

// Return the most recent active (unexpired, unused) OTP row for this user, any purpose
async function getAnyActiveOtpForUser(email, userId) {
  const result = await db.query(
    `SELECT id, code_hash, expires_at, created_at, purpose
     FROM email_otp_codes
     WHERE email = $1
       AND user_id = $2
       AND used_at IS NULL
       AND expires_at >= NOW()
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [email, userId]
  );
  return result.rows[0] || null;
}

function sanitizeProviderError(err) {
  const raw = String(err?.message || err || 'Unknown provider error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function getResendWebhookSecret() {
  return String(
    process.env.RESEND_WEBHOOK_SECRET ||
      process.env.RESEND_SIGNING_SECRET ||
      process.env.WEBHOOK_SECRET ||
      ''
  ).trim();
}

function verifyResendWebhookPayload(payload, headers) {
  const secret = getResendWebhookSecret();
  if (!secret) {
    return { verified: false, reason: 'missing_secret' };
  }

  const svixId = String(headers['svix-id'] || '').trim();
  const svixTimestamp = String(headers['svix-timestamp'] || '').trim();
  const svixSignature = String(headers['svix-signature'] || '').trim();

  if (!svixId || !svixTimestamp || !svixSignature) {
    return { verified: false, reason: 'missing_svix_headers' };
  }

  try {
    const { Webhook } = require('svix');
    const verifier = new Webhook(secret);
    verifier.verify(String(payload || ''), {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
    return { verified: true };
  } catch (err) {
    return {
      verified: false,
      reason: sanitizeProviderError(err),
    };
  }
}

const RUN_AUTH_SCHEMA_SYNC_STARTUP = String(process.env.RUN_AUTH_SCHEMA_SYNC_STARTUP || 'false').trim().toLowerCase() === 'true';
const RUN_STARTUP_BACKFILLS_SYNC = String(process.env.RUN_STARTUP_BACKFILLS_SYNC || 'false').trim().toLowerCase() === 'true';
const RUN_STARTUP_BACKFILLS = String(process.env.RUN_STARTUP_BACKFILLS || 'false').trim().toLowerCase() === 'true';

async function runAuthSchemaSetup() {
  await ensureOtpSchema();
  await ensureAntiAbuseSchema(db);
}

async function runStartupBackfills() {
  await backfillAntsLedger();
  await backfillDeterministicCustomWalletAddresses();
  await encryptLegacyWalletSeeds();
}

module.exports = async function (fastify) {
  if (RUN_AUTH_SCHEMA_SYNC_STARTUP) {
    await runAuthSchemaSetup();
  } else {
    fastify.log.info('Auth startup schema checks skipped (RUN_AUTH_SCHEMA_SYNC_STARTUP=false)');
  }

  if (RUN_STARTUP_BACKFILLS_SYNC) {
    await runStartupBackfills();
  } else if (RUN_STARTUP_BACKFILLS) {
    runStartupBackfills()
      .then(() => {
        fastify.log.info('Auth startup backfills completed');
      })
      .catch((err) => {
        fastify.log.error(err, 'Auth startup backfills failed');
      });
  } else {
    fastify.log.info('Auth startup backfills skipped (RUN_STARTUP_BACKFILLS=false)');
  }

  fastify.post('/webhooks/resend', {
    config: {
      rateLimit: { max: 180, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const payload = typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body || {});

      const verification = verifyResendWebhookPayload(payload, req.headers || {});
      const event = typeof req.body === 'object' && req.body !== null
        ? req.body
        : parseJsonSafe(payload);

      if (!event || typeof event !== 'object') {
        if (RESEND_LOG_EMAIL_EVENTS) {
          console.error('[EmailWebhook] Invalid payload received');
        }
        return reply.code(400).send({ ok: false, error: 'invalid_payload' });
      }

      if (getResendWebhookSecret() && !verification.verified) {
        if (RESEND_LOG_EMAIL_EVENTS) {
          console.error(
            `[EmailWebhook] Signature verification failed reason=${verification.reason || 'unknown'}`
          );
        }
        return reply.code(401).send({ ok: false, error: 'invalid_signature' });
      }

      const eventType = String(event.type || 'unknown').trim() || 'unknown';
      const eventData = event.data || {};
      const emailId = String(eventData.email_id || eventData.id || '').trim() || null;
      const recipient = Array.isArray(eventData.to)
        ? String(eventData.to[0] || '').trim()
        : String(eventData.to || '').trim();

      if (RESEND_LOG_EMAIL_EVENTS) {
        console.info(
          `[EmailWebhook] type=${eventType} emailId=${emailId || 'unknown'} to=${maskEmailAddress(recipient)} verified=${verification.verified}`
        );
      }

      await logAudit(db, {
        eventType: 'email_webhook_event',
        ip: req.ip,
        details: {
          type: eventType,
          emailId,
          to: recipient || null,
          verified: verification.verified,
          createdAt: event.created_at || null,
          providerData: eventData,
        },
      });

      return reply.code(200).send({ ok: true });
    } catch (err) {
      console.error('[EmailWebhook] Processing failed:', err.message || err);
      return reply.code(500).send({ ok: false, error: 'webhook_processing_failed' });
    }
  });

  /// 🔐 REGISTER + SEND OTP
  fastify.post('/register', {
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const { email, password, deviceId, deviceFingerprint, referralCode } = req.body || {};
      const ip = req.ip;
      const country = resolveCountryFromRequest(req);

      const normalizedEmail = String(email || '').trim().toLowerCase();
      const normalizedDeviceId = String(deviceId || '').trim();
      const normalizedFingerprint = String(
        deviceFingerprint || req.headers['x-device-fingerprint'] || ''
      ).trim();
      const normalizedReferralCode = normalizeReferralCode(referralCode);
      const securityEval = evaluateSecuritySignals(req, {
        deviceFingerprint: normalizedFingerprint,
      });

      if (securityEval.shouldBlock) {
        await logAudit(db, {
          eventType: 'register_blocked_insecure_runtime',
          ip,
          deviceId: normalizedDeviceId || securityEval.deviceId || null,
          deviceFingerprint: normalizedFingerprint || null,
          riskPoints: securityEval.risk,
          details: { reasons: securityEval.reasons },
        });
        return reply.code(403).send({ error: securityEval.blockReason });
      }

      let referrerId = null;
      if (normalizedReferralCode) {
        const refRow = await db.query(
          `SELECT id FROM users WHERE referral_code = $1 LIMIT 1`,
          [normalizedReferralCode]
        );
        if (refRow.rows[0]) {
          referrerId = refRow.rows[0].id;
        }
      }

      if (!normalizedEmail || !password || !normalizedDeviceId) {
        return reply.code(400).send({ error: 'Email, password and deviceId are required' });
      }

      if (!isValidEmail(normalizedEmail)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }

      if (password.length < 8) {
        return reply.code(400).send({ error: 'Password must be at least 8 characters' });
      }

      if (!normalizedFingerprint) {
        return reply.code(400).send({ error: 'Device fingerprint is required' });
      }

      const existing = await db.query(
        `SELECT id, email, email_verified, device_id, is_deleted FROM users WHERE email = $1`,
        [normalizedEmail]
      );
      const existingUserId = existing.rows[0]?.id || null;

      const absoluteDeviceAccounts = await db.query(
        `SELECT COUNT(DISTINCT LOWER(email))::int AS count
         FROM users
         WHERE COALESCE(is_deleted, FALSE) = FALSE
           AND (
             (COALESCE(device_id, '') <> '' AND device_id = $2)
             OR (
               COALESCE(device_id, '') = ''
               AND COALESCE(device_fingerprint, '') <> ''
               AND device_fingerprint = $1
             )
           )
           AND ($3::bigint IS NULL OR id <> $3)`,
        [normalizedFingerprint, normalizedDeviceId, existingUserId]
      );

      const absoluteDeviceAccountCount = Number(absoluteDeviceAccounts.rows[0]?.count || 0);
      if (absoluteDeviceAccountCount >= DEVICE_MAX_ACCOUNTS) {
        await logAudit(db, {
          eventType: 'register_device_absolute_limit_reached',
          ip,
          deviceId: normalizedDeviceId,
          deviceFingerprint: normalizedFingerprint || null,
          riskPoints: 3,
          details: {
            absoluteDeviceAccountCount,
            enforcedLimit: DEVICE_MAX_ACCOUNTS,
          },
        });
        return reply.code(429).send({ error: `You already max ${DEVICE_MAX_ACCOUNTS} accounts on this device.` });
      }

      const abuseByDevice = await db.query(
        `SELECT COUNT(DISTINCT LOWER(email))::int AS count
         FROM users
         WHERE COALESCE(is_deleted, FALSE) = FALSE
           AND COALESCE(created_at, NOW()) > NOW() - INTERVAL '24 hours'
           AND (
             (COALESCE(device_id, '') <> '' AND device_id = $2)
             OR (
               COALESCE(device_id, '') = ''
               AND COALESCE(device_fingerprint, '') <> ''
               AND device_fingerprint = $1
             )
           )`,
        [normalizedFingerprint, normalizedDeviceId]
      );

      const deviceAccountCount = Number(abuseByDevice.rows[0]?.count || 0);
      if (
        REGISTER_DEVICE_WINDOW_MAX_ACCOUNTS > 0 &&
        deviceAccountCount >= REGISTER_DEVICE_WINDOW_MAX_ACCOUNTS
      ) {
        await logAudit(db, {
          eventType: 'register_device_limit_reached',
          ip,
          deviceId: normalizedDeviceId,
          deviceFingerprint: normalizedFingerprint || null,
          riskPoints: 2,
          details: {
            deviceAccountCount,
            enforcedLimit: REGISTER_DEVICE_WINDOW_MAX_ACCOUNTS,
            hardBlock: REGISTER_DEVICE_HARD_BLOCK,
          },
        });

        if (REGISTER_DEVICE_HARD_BLOCK) {
          return reply.code(429).send({ error: 'Too many accounts from this device. Try again later.' });
        }
      }

      const abuseByIp = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM users
         WHERE last_ip = $1
           AND COALESCE(is_deleted, FALSE) = FALSE
           AND COALESCE(created_at, NOW()) > NOW() - INTERVAL '24 hours'`,
        [ip]
      );

      const ipAccountCount = Number(abuseByIp.rows[0]?.count || 0);

      if (
        REGISTER_IP_WINDOW_MAX_ACCOUNTS > 0 &&
        ipAccountCount >= REGISTER_IP_WINDOW_MAX_ACCOUNTS
      ) {
        return reply.code(429).send({ error: 'Too many accounts from this network. Try again later.' });
      }

      if (ipAccountCount >= 10) {
        await logAudit(db, {
          eventType: 'register_shared_network_threshold',
          ip,
          deviceId: normalizedDeviceId,
          deviceFingerprint: normalizedFingerprint || null,
          riskPoints: 1,
          details: {
            ipAccountCount,
            enforcedLimit: REGISTER_IP_WINDOW_MAX_ACCOUNTS,
          },
        });
      }

      const hashed = await bcrypt.hash(password, 10);
      let userId;

      if (existing.rows.length > 0) {
        const user = existing.rows[0];

        // Allow soft-deleted accounts to re-register by resetting the account
        if (Boolean(user.is_deleted)) {
          const restored = await db.query(
            `UPDATE users
             SET password = $1,
                 device_id = $2,
                 device_fingerprint = COALESCE($3, device_fingerprint),
                 last_ip = $4,
                 country = $5,
                 referred_by = COALESCE(referred_by, $6),
                 ads_active = TRUE,
                 ads_started_at = COALESCE(ads_started_at, NOW()),
                 is_deleted = FALSE,
                 deletion_scheduled_for = NULL,
                 deletion_restore_used = FALSE,
                 email_verified = FALSE,
                 is_mining = FALSE,
                 last_mining_start = NULL,
                 session_nonce = gen_random_uuid()
             WHERE id = $7
             RETURNING id`,
            [hashed, normalizedDeviceId, normalizedFingerprint || null, ip, country, referrerId, user.id]
          );
          userId = restored.rows[0].id;
          await logAudit(db, {
            eventType: 'register_restored_deleted_account',
            userId,
            ip,
            deviceId: normalizedDeviceId,
            deviceFingerprint: normalizedFingerprint || null,
            details: { email: normalizedEmail },
          });
        } else {

        if (user.email_verified) {
          return reply.code(409).send({ error: 'User already exists' });
        }

        const updated = await db.query(
          `UPDATE users
           SET password = $1,
               device_id = $2,
               device_fingerprint = COALESCE($3, device_fingerprint),
               last_ip = $4,
               country = $5,
               referred_by = COALESCE(referred_by, $6),
               is_mining = FALSE,
               last_mining_start = NULL
           WHERE id = $7
           RETURNING id`,
          [hashed, normalizedDeviceId, normalizedFingerprint || null, ip, country, referrerId, user.id]
        );
        userId = updated.rows[0].id;
        } // end of else (not deleted) block
      } else {
        const inserted = await db.query(
          `INSERT INTO users (
             email,
             password,
             device_id,
             device_fingerprint,
             last_ip,
             country,
             email_verified,
             referred_by,
             ads_active,
             ads_started_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, TRUE, NOW())
           RETURNING id`,
          [normalizedEmail, hashed, normalizedDeviceId, normalizedFingerprint || null, ip, country, referrerId]
        );
        userId = inserted.rows[0].id;
      }

      const riskEval = await evaluateRisk(db, {
        userId,
        ip,
        deviceId: normalizedDeviceId,
        deviceFingerprint: normalizedFingerprint || null,
      });
      const combinedRisk = riskEval.risk + securityEval.risk;
      const combinedReasons = [...riskEval.reasons, ...securityEval.reasons];
      if (combinedRisk > 0) {
        await addRisk(db, userId, combinedRisk, combinedReasons.join(', '), {
          flag: combinedRisk >= 5,
        });
      }

      await logAudit(db, {
        eventType: 'register',
        userId,
        ip,
        deviceId: normalizedDeviceId,
        deviceFingerprint: normalizedFingerprint || null,
        riskPoints: combinedRisk,
        details: {
          reasons: combinedReasons,
          emailVerified: false,
        },
      });

      const myReferralCode = await ensureUserReferralCode(userId);

      let otp;
      let otpSent = false;
      let otpError;
      let otpCooldown = false;
      try {
        const otpResult = await createAndSendOtp(normalizedEmail, userId, 'register');
        otp = otpResult.otp;
        otpSent = !!otpResult.sendResult?.sent;
        if (!otpSent && otpResult.sendResult?.reason) {
          otpError = otpResult.sendResult.reason;
        }
        if (otpResult.cooldown) {
          otpCooldown = true;
        }
      } catch (otpErr) {
        console.error('Register OTP send failed:', otpErr.message || otpErr);
        otpError = sanitizeProviderError(otpErr);
      }

      return {
        message: otpSent
          ? 'Registration successful. Verification code sent to your email.'
          : otpCooldown
            ? 'Registration successful. A verification code is already active — check your inbox or wait a few minutes before requesting a new one.'
            : 'Registration successful. Verification code not sent yet. Use Resend Code on login.',
        requiresVerification: true,
        mustVerifyOnNextLogin: true,
        otpSent,
        otpError,
        otpCooldown,
        referralCode: myReferralCode,
        email: normalizedEmail,
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Registration failed' });
    }
  });

  /// ✅ VERIFY OTP + COMPLETE REGISTRATION
  fastify.post('/verify-email-otp', {
    config: {
      rateLimit: { max: 12, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const { email, code } = req.body || {};
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const normalizedCode = String(code || '').trim();

      if (!normalizedEmail || !normalizedCode) {
        return reply.code(400).send({ error: 'email and code are required' });
      }

      const userRes = await db.query(
        `SELECT id, email, email_verified FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const otpRows = await getLatestActiveOtpRecords(
        normalizedEmail,
        null,
        user.id
      );
      const otpRow = otpRows[0];
      if (!otpRow) {
        return reply.code(400).send({ error: 'No verification code found. Request a new code.' });
      }

      const matchingOtp = await findMatchingOtpRecord(
        normalizedEmail,
        null,
        normalizedCode,
        user.id
      );
      if (!matchingOtp) {
        return reply.code(401).send({ error: 'Invalid verification code' });
      }

  await markAllOtpsUsedForUser(normalizedEmail, user.id);

      const verifiedUserRes = await db.query(
        `UPDATE users
         SET email_verified = TRUE
         WHERE id = $1
         RETURNING id, email, email_verified`,
        [user.id]
      );

      const session = await issueSession(verifiedUserRes.rows[0], {
        headerDeviceId: req.headers['x-device-id'],
        deviceFingerprint: req.headers['x-device-fingerprint'],
      });
      return {
        message: 'Email verified successfully',
        ...session,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Email verification failed' });
    }
  });

  /// 🔁 RESEND OTP
  fastify.post('/resend-email-otp', {
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const { email } = req.body || {};
      const normalizedEmail = String(email || '').trim().toLowerCase();

      if (!normalizedEmail) {
        return reply.code(400).send({ error: 'email is required' });
      }

      const userRes = await db.query(
        `SELECT id, email_verified FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (user.email_verified) {
        return reply.code(400).send({ error: 'Email is already verified' });
      }

      const { sendResult, otp } = await createAndSendOtp(normalizedEmail, user.id, 'register');
      if (sendResult.reason && String(sendResult.reason).startsWith('otp_cooldown:')) {
        const waitSeconds = Number(String(sendResult.reason).split(':')[1] || 0);
        const waitMins = Math.ceil(waitSeconds / 60);
        return reply.code(429).send({
          error: `A verification code was already sent. Please wait ${waitMins} minute(s) before requesting again, or check your inbox.`,
          cooldown: true,
          waitSeconds,
        });
      }

      if (!sendResult.sent && !OTP_DEBUG_MODE) {
        return reply.code(503).send({
          error: `Email service unavailable: ${sendResult.reason || 'Provider rejected the request'}`,
        });
      }

      return {
        message: 'Verification code resent',
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(503).send({
        error: `Failed to resend code: ${sanitizeProviderError(err)}`,
      });
    }
  });

  fastify.post('/account-restore/request', {
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const email = sanitizeText(req.body?.email || '', 255).toLowerCase();
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'account_restore_request_blocked_insecure_runtime',
        email,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidEmail(email)) {
        return reply.code(400).send({ success: false, message: 'Invalid email format' });
      }

      const userRes = await db.query(
        `SELECT id, email, is_deleted, deletion_scheduled_for, deletion_restore_used
         FROM users
         WHERE email = $1
         LIMIT 1`,
        [email]
      );
      const user = userRes.rows[0];

      if (!user || !Boolean(user.is_deleted) || !user.deletion_scheduled_for) {
        return {
          success: true,
          message: 'If this account is eligible for recovery, a restore code was sent.',
        };
      }

      if (Boolean(user.deletion_restore_used)) {
        return reply.code(403).send({
          success: false,
          message: 'This account has already used its one-time recovery and cannot be restored again.',
        });
      }

      const { sendResult, otp } = await createAndSendOtp(email, user.id, 'restore_account');
      if (sendResult.reason && String(sendResult.reason).startsWith('otp_cooldown:')) {
        const waitSeconds = Number(String(sendResult.reason).split(':')[1] || 0);
        const waitMins = Math.ceil(waitSeconds / 60);
        return reply.code(429).send({
          success: false,
          message: `A restore code was already sent to this account. Please wait ${waitMins} minute(s) before requesting again, or check your inbox.`,
          cooldown: true,
          waitSeconds,
        });
      }

      if (!sendResult.sent && !OTP_DEBUG_MODE) {
        return reply.code(503).send({
          success: false,
          message: `Email service unavailable: ${sendResult.reason || 'Provider rejected the request'}`,
        });
      }

      await logAudit(db, {
        eventType: 'account_restore_otp_requested',
        userId: user.id,
        ip: req.ip,
      });

      return {
        success: true,
        message: 'Restore code sent to your email. This recovery can only be used once.',
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(503).send({
        success: false,
        message: `Failed to send restore code: ${sanitizeProviderError(err)}`,
      });
    }
  });

  fastify.post('/account-restore/confirm', {
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const email = sanitizeText(req.body?.email || '', 255).toLowerCase();
      const code = sanitizeText(req.body?.code || '', 10);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'account_restore_confirm_blocked_insecure_runtime',
        email,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidEmail(email) || !isValidOtp(code)) {
        return reply.code(400).send({ success: false, message: 'Invalid input' });
      }

      const userRes = await db.query(
        `SELECT id, email, is_deleted, deletion_scheduled_for, deletion_restore_used
         FROM users
         WHERE email = $1
         LIMIT 1`,
        [email]
      );
      const user = userRes.rows[0];

      if (!user || !Boolean(user.is_deleted) || !user.deletion_scheduled_for) {
        return reply.code(400).send({
          success: false,
          message: 'No recoverable scheduled deletion was found for this account.',
        });
      }

      if (Boolean(user.deletion_restore_used)) {
        return reply.code(403).send({
          success: false,
          message: 'This account has already used its one-time recovery and cannot be restored again.',
        });
      }

      // Universal OTP lookup — the stored code works for any purpose
      const otpRow = await findMatchingOtpRecord(email, null, code, user.id);
      if (!otpRow) {
        const hasAny = await getLatestActiveOtpRecords(email, null, user.id);
        if (!hasAny.length) {
          return reply.code(400).send({ success: false, message: 'No active restore code found. Request a new code.' });
        }
        return reply.code(401).send({ success: false, message: 'Invalid restore code' });
      }

      await markAllOtpsUsedForUser(email, user.id);

      await db.query(
        `UPDATE users
         SET is_deleted = FALSE,
             deletion_requested_at = NULL,
             deletion_scheduled_for = NULL,
             deletion_restore_used = TRUE,
             deletion_restored_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [user.id]
      );

      await logAudit(db, {
        eventType: 'account_restored_once',
        userId: user.id,
        ip: req.ip,
      });

      return {
        success: true,
        message: 'Account restored successfully. This one-time recovery has now been used. Please log in again.',
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to restore account' });
    }
  });

  /// 🔐 LOGIN
  fastify.post('/login', {
    config: {
      rateLimit: { max: 15, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const { email, password, deviceId, deviceFingerprint } = req.body || {};
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const normalizedDeviceId = String(deviceId || '').trim();
      const normalizedFingerprint = String(
        deviceFingerprint || req.headers['x-device-fingerprint'] || ''
      ).trim();
      const requestLang = normalizeLang(req.body?.language);
      const securityEval = evaluateSecuritySignals(req, {
        deviceFingerprint: normalizedFingerprint,
      });

      if (securityEval.shouldBlock) {
        await logAudit(db, {
          eventType: 'login_blocked_insecure_runtime',
          ip: req.ip,
          deviceId: normalizedDeviceId || securityEval.deviceId || null,
          deviceFingerprint: normalizedFingerprint || null,
          riskPoints: securityEval.risk,
          details: { reasons: securityEval.reasons, email: normalizedEmail || null },
        });
        return reply.code(403).send({ success: false, message: securityEval.blockReason });
      }

      if (!normalizedEmail || !password || !normalizedDeviceId) {
        return reply.code(400).send({ success: false, message: t('error.email_password_required', requestLang) });
      }

      if (!isValidEmail(normalizedEmail)) {
        return reply.code(400).send({ success: false, message: t('error.invalid_email', requestLang) });
      }

      const result = await db.query(
        `SELECT * FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      const user = result.rows[0];
      if (!user) {
        return reply.code(401).send({ success: false, message: t('error.invalid_credentials', requestLang) });
      }

      if (Boolean(user.is_deleted)) {
        const accountRestoreEligible = Boolean(user.deletion_scheduled_for) && !Boolean(user.deletion_restore_used);
        return reply.code(403).send({
          success: false,
          message: accountRestoreEligible
            ? 'This account is scheduled for deletion. You can restore it via email recovery, or register again with the same email.'
            : 'This account has been removed. You can register again with the same email to create a fresh account.',
          accountRestoreEligible,
        });
      }

      const lang = normalizeLang(user.preferred_language || requestLang);

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return reply.code(401).send({ success: false, message: t('error.invalid_credentials', lang) });
      }

      await repairUserSessionLedger(user.id);

      if (!user.email_verified) {
        const activeRegisterOtps = await getLatestActiveOtpRecords(
          user.email,
          'register',
          user.id
        );
        if (activeRegisterOtps.length > 0) {
          return reply.code(403).send({
            success: false,
            message: 'Email not verified. Enter the active verification code or tap Resend Code for a new one.',
            requiresVerification: true,
            email: user.email,
            otpSent: true,
          });
        }

        let otp;
        let otpSent = false;
        let otpError;
        try {
          const otpResult = await createAndSendOtp(user.email, user.id, 'register');
          otp = otpResult.otp;
          otpSent = !!otpResult.sendResult?.sent;
          if (!otpSent && otpResult.sendResult?.reason) {
            otpError = otpResult.sendResult.reason;
          }
        } catch (otpErr) {
          console.error('Login OTP send failed:', otpErr.message || otpErr);
          otpError = sanitizeProviderError(otpErr);
        }

        return reply.code(403).send({
          success: false,
          message: otpSent
            ? 'Email not verified. Please verify with OTP code.'
            : 'Email not verified. OTP could not be delivered. Tap Resend Code after opening verification.',
          requiresVerification: true,
          email: user.email,
          otpSent,
          otpError,
          debugOtp: OTP_DEBUG_MODE ? otp : undefined,
        });
      }

      const isNewDevice = !!user.device_id && user.device_id !== normalizedDeviceId;
      const isNewIp = !!user.last_ip && user.last_ip !== req.ip;
      const deviceUntrusted = !Boolean(user.is_trusted_device);
      const otpRequired = LOGIN_DEVICE_OTP_REQUIRED && (isNewDevice || isNewIp || deviceUntrusted);

      if (otpRequired) {
        const { otp, otpSent, otpError } = await issueLoginOtp(user);

        if (otpError && String(otpError).startsWith('otp_cooldown:')) {
          const waitSeconds = Number(String(otpError).split(':')[1] || 0);
          const waitMins = Math.ceil(waitSeconds / 60);
          return reply.code(200).send({
            success: true,
            otp_required: true,
            message: `A verification code was already sent. Enter the active code from your inbox, or request a new one in ${waitMins} minute(s).`,
            email: user.email,
            cooldown: true,
            waitSeconds,
            otpSent: false,
          });
        }

        if (!otpSent && !OTP_DEBUG_MODE) {
          return reply.code(503).send({
            success: false,
            message: otpError
              ? `Login verification code could not be delivered: ${otpError}`
              : 'Login verification code could not be delivered. Please try again.',
            otp_required: false,
            otpSent: false,
          });
        }

        return reply.code(200).send({
          success: true,
          otp_required: true,
          message: t('success.otp_sent', lang),
          email: user.email,
          otpSent,
          otpError,
          debugOtp: OTP_DEBUG_MODE ? otp : undefined,
        });
      }

      await db.query(
        `UPDATE users
         SET last_ip = $1,
             country = $2,
             device_id = $3,
             device_fingerprint = COALESCE($4, device_fingerprint),
             is_trusted_device = TRUE,
             otp_code = NULL,
             otp_expiry = NULL,
             otp_attempts = 0
         WHERE id = $5`,
        [req.ip, resolveCountryFromRequest(req), normalizedDeviceId, normalizedFingerprint || null, user.id]
      );

      const riskEval = await evaluateRisk(db, {
        userId: user.id,
        ip: req.ip,
        deviceId: normalizedDeviceId,
        deviceFingerprint: normalizedFingerprint || null,
      });
      const combinedRisk = riskEval.risk + securityEval.risk;
      const combinedReasons = [...riskEval.reasons, ...securityEval.reasons];
      if (combinedRisk > 0) {
        await addRisk(db, user.id, combinedRisk, combinedReasons.join(', '), {
          flag: combinedRisk >= 5,
        });
      }

      await logAudit(db, {
        eventType: 'login',
        userId: user.id,
        ip: req.ip,
        deviceId: normalizedDeviceId,
        deviceFingerprint: normalizedFingerprint || null,
        riskPoints: combinedRisk,
        details: { reasons: combinedReasons },
      });

      const session = await issueSession(user, {
        deviceId: normalizedDeviceId,
        deviceFingerprint: normalizedFingerprint,
      });
      return {
        success: true,
        message: t('success.login', lang),
        ...session,
      };
    } catch (err) {
      if (err.code === '53300' || err.code === '53200' || err.code === '53100') {
        console.warn('[login] DB connection limit hit, returning 503:', err.message);
        return reply.code(503).send({ success: false, message: 'Server is under high load. Please try again in a moment.' });
      }
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Login failed' });
    }
  });

  fastify.post('/verify-login-otp', {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const email = sanitizeText(req.body?.email || '').toLowerCase();
      const otp = sanitizeText(req.body?.otp || req.body?.code || '', 10);
      const deviceId = sanitizeText(req.body?.deviceId || '', 255);
      const deviceFingerprint = String(req.headers['x-device-fingerprint'] || '').trim();
      const langHint = normalizeLang(req.body?.language);

      if (!email || !otp || !deviceId || !isValidOtp(otp)) {
        return reply.code(400).send({ success: false, message: t('error.invalid_input', langHint) });
      }

      const userRes = await db.query(
        `SELECT * FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: t('error.user_not_found', langHint) });
      }

      const lang = normalizeLang(user.preferred_language || langHint);
      const latestLoginOtp = await getAnyActiveOtpForUser(email, user.id);
      const hasLegacyOtp = !!user.otp_code && !!user.otp_expiry;
      const hasRecordOtp = !!latestLoginOtp;

      if (!hasLegacyOtp && !hasRecordOtp) {
        return reply.code(400).send({ success: false, message: t('error.otp_required', lang) });
      }

      if (Number(user.otp_attempts || 0) >= OTP_MAX_ATTEMPTS) {
        return reply.code(429).send({ success: false, message: t('error.otp_attempts_exceeded', lang) });
      }

      const legacyExpired = hasLegacyOtp && new Date(user.otp_expiry) < new Date();
      const hasActiveLegacyOtp = hasLegacyOtp && !legacyExpired;
      const hasActiveRecordOtp = hasRecordOtp;

      if (!hasActiveLegacyOtp && !hasActiveRecordOtp) {
        return reply.code(400).send({ success: false, message: t('error.otp_expired', lang) });
      }

      let isValid = false;
      const matchingLoginOtp = hasActiveRecordOtp
        ? await findMatchingOtpRecord(email, null, otp, user.id)
        : null;
      if (hasActiveLegacyOtp) {
        isValid = await bcrypt.compare(otp, user.otp_code);
      }
      if (!isValid && matchingLoginOtp) {
        isValid = true;
      }

      if (!isValid) {
        await db.query('UPDATE users SET otp_attempts = COALESCE(otp_attempts, 0) + 1 WHERE id = $1', [user.id]);
        return reply.code(401).send({ success: false, message: t('error.otp_invalid', lang) });
      }

      await db.query(
        `UPDATE users
         SET is_trusted_device = TRUE,
             device_id = $1,
             last_ip = $2,
             otp_code = NULL,
             otp_expiry = NULL,
             otp_attempts = 0
         WHERE id = $3`,
        [deviceId, req.ip, user.id]
      );

      if (hasActiveRecordOtp) {
        await markAllOtpsUsedForUser(email, user.id);
      }

      const session = await issueSession(user, {
        deviceId,
        deviceFingerprint,
      });
      return {
        success: true,
        message: t('success.otp_verified', lang),
        ...session,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'OTP verification failed' });
    }
  });

  fastify.post('/resend-login-otp', {
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const email = sanitizeText(req.body?.email || '', 255).toLowerCase();
      const deviceId = sanitizeText(req.body?.deviceId || '', 255);
      const deviceFingerprint = String(
        req.body?.deviceFingerprint || req.headers['x-device-fingerprint'] || ''
      ).trim();
      const langHint = normalizeLang(req.body?.language);

      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'resend_login_otp_blocked_insecure_runtime',
        email,
        deviceId,
        deviceFingerprint,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidEmail(email) || !deviceId) {
        return reply.code(400).send({ success: false, message: t('error.invalid_input', langHint) });
      }

      const userRes = await db.query(
        `SELECT * FROM users WHERE email = $1 LIMIT 1`,
        [email]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: t('error.user_not_found', langHint) });
      }

      const lang = normalizeLang(user.preferred_language || langHint);

      if (Boolean(user.is_deleted)) {
        return reply.code(403).send({
          success: false,
          message: 'This account has been removed. Please register again or contact support.',
        });
      }

      if (!user.email_verified) {
        return reply.code(403).send({
          success: false,
          message: 'Email not verified. Enter the active verification code or tap Resend Code for a new one.',
          requiresVerification: true,
          email: user.email,
        });
      }

      const { otp, otpSent, otpError } = await issueLoginOtp(user);
      // Handle cooldown: OTP was issued recently, ask user to wait
      if (otpError && String(otpError).startsWith('otp_cooldown:')) {
        const waitSeconds = Number(String(otpError).split(':')[1] || 0);
        const waitMins = Math.ceil(waitSeconds / 60);
        return reply.code(429).send({
          success: false,
          message: `A verification code was already sent. Please wait ${waitMins} minute(s) before requesting again, or check your inbox.`,
          cooldown: true,
          waitSeconds,
        });
      }

      if (!otpSent && !OTP_DEBUG_MODE) {
        return reply.code(503).send({
          success: false,
          message: otpError
            ? `Login verification code could not be delivered: ${otpError}`
            : 'Login verification code could not be delivered. Please try again.',
          otpSent: false,
        });
      }

      return {
        success: true,
        message: t('success.otp_sent', lang),
        email: user.email,
        otpSent,
        otpError,
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to resend login OTP' });
    }
  });

  fastify.post('/set-language', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId || req.user.id;
      const requested = sanitizeText(req.body?.language || '', 8).toLowerCase();
      const allowed = ['en', 'tl'];
      if (!allowed.includes(requested)) {
        return reply.code(400).send({ success: false, message: t('error.language_invalid', 'en') });
      }

      await db.query(
        `UPDATE users
         SET preferred_language = $1
         WHERE id = $2`,
        [requested, userId]
      );

      return {
        success: true,
        message: t('success.language_updated', requested),
        preferred_language: requested,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to update language' });
    }
  });

  /// 🔑 REQUEST PASSWORD RESET OTP
  fastify.post('/forgot-password/request', {
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const { email } = req.body || {};
      const normalizedEmail = String(email || '').trim().toLowerCase();

      if (!normalizedEmail) {
        return reply.code(400).send({ error: 'email is required' });
      }

      if (!isValidEmail(normalizedEmail)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }

      const userRes = await db.query(
        `SELECT id, email_verified FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      const user = userRes.rows[0];
      if (!user) {
        return {
          message: 'If this email is registered, a reset code has been sent.',
        };
      }

      if (!user.email_verified) {
        return reply.code(403).send({ error: 'Email is not verified yet. Verify your email first.' });
      }

      const { sendResult, otp } = await createAndSendOtp(normalizedEmail, user.id, 'reset_password');
      if (sendResult.reason && String(sendResult.reason).startsWith('otp_cooldown:')) {
        const waitSeconds = Number(String(sendResult.reason).split(':')[1] || 0);
        const waitMins = Math.ceil(waitSeconds / 60);
        return reply.code(429).send({
          error: `A verification code was already sent to this account. Please wait ${waitMins} minute(s) before requesting again, or check your inbox.`,
          cooldown: true,
          waitSeconds,
        });
      }

      if (!sendResult.sent && !OTP_DEBUG_MODE) {
        return reply.code(503).send({
          error: `Email service unavailable: ${sendResult.reason || 'Provider rejected the request'}`,
        });
      }

      return {
        message: 'Password reset code sent to your email',
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(503).send({
        error: `Failed to send reset code: ${sanitizeProviderError(err)}`,
      });
    }
  });

  /// 🔑 CONFIRM PASSWORD RESET OTP
  fastify.post('/forgot-password/confirm', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const { email, code, newPassword } = req.body || {};
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const normalizedCode = String(code || '').trim();

      if (!normalizedEmail || !normalizedCode || !newPassword) {
        return reply.code(400).send({ error: 'email, code and newPassword are required' });
      }

      if (!isValidEmail(normalizedEmail)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }

      if (String(newPassword).length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      const userRes = await db.query(
        `SELECT id FROM users WHERE email = $1`,
        [normalizedEmail]
      );

      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      // Universal OTP lookup — the stored code works for any purpose
      const otpRow = await findMatchingOtpRecord(normalizedEmail, null, normalizedCode, user.id);
      if (!otpRow) {
        const hasAny = await getLatestActiveOtpRecords(normalizedEmail, null, user.id);
        if (!hasAny.length) {
          return reply.code(400).send({ error: 'No reset code found. Request a new code.' });
        }
        return reply.code(401).send({ error: 'Invalid reset code' });
      }

      const hashed = await bcrypt.hash(String(newPassword), 10);
      await markAllOtpsUsedForUser(normalizedEmail, user.id);
      await db.query(
        `UPDATE users
         SET password = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [hashed, user.id]
      );

      return {
        message: 'Password reset successful. You can now log in with your new password.',
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to reset password' });
    }
  });

  fastify.get('/me', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const cacheKey = buildAuthReadCacheKey(userId, 'me');
      return await getOrLoadAuthReadCache(cacheKey, async () => {
        const result = await db.query(
          `SELECT id, email, email_verified, country, created_at, successful_sessions, referral_code,
                  wallet_address, balance, ant_balance, ants_balance,
                  ads_active, supporter_badge, supporter_since, total_ad_impressions,
                  active_nft_profile_id, profile_avatar_type, profile_avatar_url,
                  nft_activated, nft_activated_at, first_settlement_at,
                  migration_wallet_address, is_validator_candidate, validator_status
           FROM users
           WHERE id = $1`,
          [userId]
        );

        const user = result.rows[0];
        if (!user) {
          return { __errorCode: 404, error: 'User not found' };
        }

        const referralCode = await ensureUserReferralCode(userId, user.referral_code);
        user.referral_code = referralCode;

        const appBalanceAnts = Math.max(
          Number(user.ants_balance || 0),
          Number(user.ant_balance || 0)
        );

        return {
          user: {
            ...user,
            walletAddress: user.wallet_address || null,
            hasWallet: Boolean(user.wallet_address),
            anetBalance: Number(user.balance || 0),
            appBalanceAnts,
            appBalance: antsToAnet(appBalanceAnts),
            adsActive: user.ads_active !== false,
            supporterBadge: Boolean(user.supporter_badge),
            supporterSince: user.supporter_since || null,
            totalAdImpressions: Number(user.total_ad_impressions || 0),
            validatorInfo: {
              isCandidate: Boolean(user.is_validator_candidate),
              status: user.validator_status || 'MINER',
              emailVerified: Boolean(user.email_verified),
              walletSet: Boolean(user.wallet_address),
              migrationWalletSet: Boolean(user.migration_wallet_address),
              sessionsCompleted: Number(user.successful_sessions || 0),
            },
          },
        };
      }).then((payload) => {
        if (payload && payload.__errorCode) {
          return reply.code(payload.__errorCode).send({ error: payload.error });
        }
        return payload;
      });
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to load profile' });
    }
  });

  fastify.get('/wallet', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const cacheKey = buildAuthReadCacheKey(userId, 'wallet');
      return await getOrLoadAuthReadCache(cacheKey, async () => {
        const walletRes = await db.query(
          `SELECT wallet_address, custom_wallet_address, migration_wallet_address, balance, ant_balance, ants_balance, pin_enabled,
                  active_nft_profile_id, profile_avatar_type, profile_avatar_url, nft_activated, nft_activated_at, first_settlement_at
           FROM users
           WHERE id = $1`,
          [userId]
        );

        const row = walletRes.rows[0];
        if (!row) {
          return { __errorCode: 404, error: 'User not found' };
        }

        return {
          hasWallet: !!row.wallet_address,
          security: {
            pinEnabled: Boolean(row.pin_enabled),
            seedOtpRequired: SEED_OTP_REQUIRED,
            seedStoredEncrypted: Boolean(row.wallet_address),
          },
          wallet: row.wallet_address
            ? {
                address: row.wallet_address,
                customAddress: row.custom_wallet_address,
                displayAddress: row.custom_wallet_address || row.wallet_address,
                migrationAddress: row.migration_wallet_address,
                appBalance: antsToAnet(Math.max(Number(row.ants_balance || 0), Number(row.ant_balance || 0))),
                appBalanceAnts: Math.max(Number(row.ants_balance || 0), Number(row.ant_balance || 0)),
              }
            : null,
          nft: {
            activeProfileId: row.active_nft_profile_id,
            activated: Boolean(row.nft_activated),
            activationAt: row.nft_activated_at,
            firstSettlementAt: row.first_settlement_at,
            avatarType: row.profile_avatar_type || 'default',
            avatarUrl: row.profile_avatar_url || null,
          },
        };
      }).then((payload) => {
        if (payload && payload.__errorCode) {
          return reply.code(payload.__errorCode).send({ error: payload.error });
        }
        return payload;
      });
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to load wallet' });
    }
  });

  fastify.post('/wallet/create', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const rawMigrationInput = String(req.body?.migrationAddress || '').trim();
      const migrationAddress = sanitizeMigrationAddress(req.body?.migrationAddress);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'wallet_create_blocked_insecure_runtime',
        userId,
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (rawMigrationInput && !migrationAddress) {
        return reply.code(400).send({ error: 'Migration wallet must be a valid ANET address.' });
      }

      if (migrationAddress && !(await ensureMigrationWalletAvailable(migrationAddress, userId))) {
        return reply.code(409).send({ error: 'Migration wallet is already in use by another account.' });
      }

      const userRes = await db.query(
        `SELECT id, email_verified, wallet_address, custom_wallet_address, migration_wallet_address, balance, ant_balance, ants_balance, pin_enabled
         FROM users
         WHERE id = $1`,
        [userId]
      );

      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (!user.email_verified) {
        return reply.code(403).send({ error: 'Email not verified. Verify OTP before creating wallet.' });
      }

      if (user.wallet_address) {
        return reply.code(409).send({
          error: 'Wallet already exists for this account',
          hasWallet: true,
          security: {
            pinEnabled: Boolean(user.pin_enabled),
            seedOtpRequired: SEED_OTP_REQUIRED,
            seedStoredEncrypted: true,
          },
          wallet: {
            address: user.wallet_address,
            customAddress: user.custom_wallet_address,
            displayAddress: user.custom_wallet_address || user.wallet_address,
            migrationAddress: user.migration_wallet_address,
            appBalance: antsToAnet(Math.max(Number(user.ants_balance || 0), Number(user.ant_balance || 0))),
            appBalanceAnts: Math.max(Number(user.ants_balance || 0), Number(user.ant_balance || 0)),
          },
        });
      }

      let created;
      let createdSeedPhrase = null;
      for (let i = 0; i < 5; i += 1) {
        const generated = createWallet();
        const address = generated.address;
        const passphrase = generated.seed;
        const encryptedSeed = encryptSecret(passphrase);
        const customAddress = generated.address;

        try {
          const updateRes = await db.query(
            `UPDATE users
             SET wallet_address            = $1,
                 wallet_seed_encrypted     = $2,
                 wallet_seed_iv            = $3,
                 wallet_seed_tag           = $4,
                 wallet_seed_key_version   = 2,
                 wallet_passphrase         = NULL,
                 custom_wallet_address     = $5,
                 migration_wallet_address  = COALESCE($6, migration_wallet_address)
             WHERE id = $7
               AND wallet_address IS NULL
             RETURNING wallet_address, custom_wallet_address, migration_wallet_address, balance, ant_balance, ants_balance`,
            [
              address,
              encryptedSeed.encrypted,
              encryptedSeed.iv,
              encryptedSeed.tag,
              customAddress,
              migrationAddress,
              userId,
            ]
          );

          if (updateRes.rows[0]) {
            created = updateRes.rows[0];
            createdSeedPhrase = passphrase;
            break;
          }
        } catch (e) {
          if (e.code !== '23505') {
            throw e;
          }
        }
      }

      if (!created) {
        const existingRes = await db.query(
          `SELECT wallet_address, custom_wallet_address, migration_wallet_address, balance, ant_balance, ants_balance
           FROM users
           WHERE id = $1`,
          [userId]
        );
        const existing = existingRes.rows[0];

        if (existing?.wallet_address) {
          return reply.code(409).send({
            error: 'Wallet already exists for this account',
            hasWallet: true,
            security: {
              pinEnabled: Boolean(user.pin_enabled),
              seedOtpRequired: SEED_OTP_REQUIRED,
              seedStoredEncrypted: true,
            },
            wallet: {
              address: existing.wallet_address,
              customAddress: existing.custom_wallet_address,
              displayAddress: existing.custom_wallet_address || existing.wallet_address,
              migrationAddress: existing.migration_wallet_address,
              appBalance: antsToAnet(Math.max(Number(existing.ants_balance || 0), Number(existing.ant_balance || 0))),
              appBalanceAnts: Math.max(Number(existing.ants_balance || 0), Number(existing.ant_balance || 0)),
            },
          });
        }

        return reply.code(500).send({ error: 'Failed to create wallet. Please try again.' });
      }

      return {
        message: 'Wallet created successfully',
        hasWallet: true,
        security: {
          pinEnabled: Boolean(user.pin_enabled),
          seedOtpRequired: SEED_OTP_REQUIRED,
          seedStoredEncrypted: true,
        },
        oneTimeSeedPhrase: createdSeedPhrase,
        wallet: {
          address: created.wallet_address,
          customAddress: created.custom_wallet_address,
          displayAddress: created.custom_wallet_address || created.wallet_address,
          migrationAddress: created.migration_wallet_address,
          appBalance: antsToAnet(Math.max(Number(created.ants_balance || 0), Number(created.ant_balance || 0))),
          appBalanceAnts: Math.max(Number(created.ants_balance || 0), Number(created.ant_balance || 0)),
        },
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Wallet creation failed' });
    } finally {
      clearAuthReadCacheForUser(req.user.userId);
    }
  });

  fastify.post('/wallet/migration-address', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 12, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const migrationAddress = sanitizeMigrationAddress(req.body?.migrationAddress);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'migration_wallet_update_blocked_insecure_runtime',
        userId,
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!migrationAddress) {
        return reply.code(400).send({ error: 'Migration wallet must be a valid ANET address.' });
      }

      if (!(await ensureMigrationWalletAvailable(migrationAddress, userId))) {
        return reply.code(409).send({ error: 'Migration wallet is already in use by another account.' });
      }

      const updateRes = await db.query(
        `UPDATE users
         SET migration_wallet_address = $1
         WHERE id = $2
         RETURNING wallet_address, custom_wallet_address, migration_wallet_address, balance, ant_balance, ants_balance, email_verified, is_banned, risk_score, successful_sessions, total_sessions`,
        [migrationAddress, userId]
      );

      const row = updateRes.rows[0];
      if (!row) {
        return reply.code(404).send({ error: 'User not found' });
      }

      try {
        const { buildValidatorCandidateState } = require('../services/sessionProofs');
        const candidateState = buildValidatorCandidateState({
          wallet: row.wallet_address,
          migrationWallet: row.migration_wallet_address,
          emailVerified: Boolean(row.email_verified),
          isBanned: Boolean(row.is_banned),
          riskScore: Number(row.risk_score || 0),
          totalSessions: Number(row.total_sessions || row.successful_sessions || 0),
        });
        if (candidateState.isValidatorCandidate) {
          await db.query(
            `UPDATE users
             SET is_validator_candidate = TRUE,
                 validator_status = $2,
                 validator_joined_at = COALESCE(validator_joined_at, NOW()),
                 validator_key = COALESCE(validator_key, $3),
                 validator_reputation = COALESCE(validator_reputation, 0)
             WHERE id = $1`,
            [userId, candidateState.validatorStatus, candidateState.validatorKey]
          );
        }
      } catch (_) {}

      return {
        message: 'Migration wallet address saved',
        hasWallet: !!row.wallet_address,
        wallet: {
          address: row.wallet_address,
          customAddress: row.custom_wallet_address,
          displayAddress: row.custom_wallet_address || row.wallet_address,
          migrationAddress: row.migration_wallet_address,
          appBalance: antsToAnet(Math.max(Number(row.ants_balance || 0), Number(row.ant_balance || 0))),
          appBalanceAnts: Math.max(Number(row.ants_balance || 0), Number(row.ant_balance || 0)),
        },
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to save migration wallet address' });
    } finally {
      clearAuthReadCacheForUser(req.user.userId);
    }
  });

  fastify.get('/wallet/history', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const limitRaw = Number(req.query?.limit || 30);
      const offsetRaw = Number(req.query?.offset || 0);
      const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 30));
      const offset = Math.max(0, Number.isFinite(offsetRaw) ? Math.trunc(offsetRaw) : 0);

      const historyRes = await db.query(
        `SELECT id,
                transaction_type,
                amount,
                from_address,
                to_address,
                description,
                status,
                created_at
         FROM ant_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      return {
        success: true,
        history: historyRes.rows,
        count: historyRes.rows.length,
      };
    } catch (err) {
      if (err && err.code === '42P01') {
        return {
          success: true,
          history: [],
          count: 0,
          legacyFallback: true,
        };
      }
      console.error(err);
      return reply.code(500).send({ error: 'Failed to load wallet coin history' });
    }
  });

  fastify.post('/wallet/transfer-intent', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 12, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const toAddress = sanitizeText(req.body?.toAddress || '', 160).toUpperCase();
      const amountRaw = String(req.body?.amountAnet || '').trim();
      const amountAnet = Number(amountRaw);

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }

      if (!isValidANETWallet(toAddress)) {
        return reply.code(400).send({ success: false, message: 'Recipient must be a valid ANET wallet address' });
      }

      if (!Number.isFinite(amountAnet) || amountAnet <= 0) {
        return reply.code(400).send({ success: false, message: 'Amount must be greater than 0 ANET' });
      }

      const amountAnts = Math.round(amountAnet * ANTS_PER_ANET);
      if (!Number.isFinite(amountAnts) || amountAnts <= 0) {
        return reply.code(400).send({ success: false, message: 'Amount is too small for ANET precision' });
      }

      const userRes = await db.query(
        `SELECT id,
                pin_hash,
                pin_enabled,
                wallet_address,
                custom_wallet_address,
                successful_sessions,
                ants_balance,
                ant_balance
         FROM users
         WHERE id = $1
           AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }

      if (!user.pin_hash || user.pin_enabled !== true) {
        return reply.code(400).send({ success: false, message: 'Set your wallet PIN first' });
      }

      const pinValid = await bcrypt.compare(pin, user.pin_hash);
      if (!pinValid) {
        return reply.code(401).send({ success: false, message: 'Invalid PIN' });
      }

      const completedSessions = Number(user.successful_sessions || 0);
      if (completedSessions < 1000) {
        return reply.code(403).send({
          success: false,
          message: 'ANET coin transfer unlocks after 1,000 completed sessions',
          progress: {
            completedSessions,
            requiredSessions: 1000,
          },
        });
      }

      const senderWallet = String(user.custom_wallet_address || user.wallet_address || '').trim();
      if (!senderWallet) {
        return reply.code(400).send({ success: false, message: 'Create your wallet first' });
      }

      if (senderWallet.toUpperCase() === toAddress) {
        return reply.code(400).send({ success: false, message: 'Sender and recipient wallet cannot be the same' });
      }

      const availableAnts = Math.max(Number(user.ants_balance || 0), Number(user.ant_balance || 0));
      if (amountAnts > availableAnts) {
        return reply.code(400).send({
          success: false,
          message: 'Insufficient ANET balance',
          details: {
            availableAnet: antsToAnet(availableAnts),
            requestedAnet: amountAnet,
          },
        });
      }

      try {
        await db.query(
          `INSERT INTO ant_transactions
             (user_id, transaction_type, amount, from_address, to_address, description, status, created_at)
           VALUES
             ($1, 'wallet_transfer_intent', $2, $3, $4, $5, 'pending', NOW())`,
          [
            userId,
            amountAnts,
            senderWallet,
            toAddress,
            `Wallet send intent ${amountAnet.toFixed(8)} ANET`,
          ]
        );
      } catch (persistErr) {
        if (!persistErr || persistErr.code !== '42P01') {
          throw persistErr;
        }
      }

      await logAudit(db, {
        eventType: 'wallet_transfer_intent_created',
        userId,
        ip: req.ip,
        details: {
          fromWallet: senderWallet,
          toWallet: toAddress,
          amountAnet,
          amountAnts,
        },
      });

      return {
        success: true,
        message: 'Transfer intent validated',
        transfer: {
          fromWallet: senderWallet,
          toWallet: toAddress,
          amountAnet,
          amountAnts,
        },
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to prepare transfer intent' });
    }
  });

  /// 👥 F1 REFERRAL TRACKING (NO REWARD/BOOST)
  fastify.get('/referrals/me', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 25, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const cacheKey = buildAuthReadCacheKey(userId, 'referrals-me');
      return await getOrLoadAuthReadCache(cacheKey, async () => {
        const meRes = await db.readQuery(
          `SELECT
             id,
             successful_sessions,
             referral_code,
             referred_by
           FROM users
           WHERE id = $1`,
          [userId]
        );

        const me = meRes.rows[0];
        if (!me) {
          return { __errorCode: 404, error: 'User not found' };
        }

        const inviteCode = await ensureUserReferralCode(userId, me.referral_code);

        const referralProgressRes = await db.readQuery(
          `WITH referred AS (
             SELECT
               u.id,
               u.successful_sessions,
               u.referral_code,
               u.created_at
             FROM users u
             WHERE u.referred_by = $1
           ),
           completed AS (
             SELECT
               ms.user_id,
               COUNT(*)::bigint AS completed_sessions
             FROM mining_sessions ms
             JOIN referred r ON r.id = ms.user_id
             WHERE ms.is_completed = TRUE
               AND COALESCE(ms.status, '') = 'completed'
             GROUP BY ms.user_id
           )
           SELECT
             r.id,
             COALESCE(NULLIF(r.referral_code, ''), 'User ' || r.id::text) AS label,
             LEAST(
               COALESCE(r.successful_sessions, 0),
               COALESCE(c.completed_sessions, COALESCE(r.successful_sessions, 0))
             )::int AS successful_sessions,
             r.created_at
           FROM referred r
           LEFT JOIN completed c ON c.user_id = r.id
           ORDER BY successful_sessions DESC, r.created_at ASC, r.id ASC`,
          [userId]
        );

        const mySessions = Number(me.successful_sessions || 0);
        const referralProgress = (referralProgressRes.rows || []).map((row) => {
          const successfulSessions = Number(row.successful_sessions || 0);
          return {
            id: Number(row.id),
            label: String(row.label || `User ${row.id}`).trim(),
            successfulSessions,
            remainingTo1k: Math.max(0, 1000 - successfulSessions),
            completed1k: successfulSessions >= 1000,
          };
        });
        const totalReferrals = referralProgress.length;
        const qualifiedReferrals = referralProgress.filter((row) => row.completed1k).length;
        const totalReferralSessions = referralProgress.reduce(
          (sum, row) => sum + Number(row.successfulSessions || 0),
          0
        );

        return {
          model: 'F1',
          rewardsEnabled: false,
          boostsEnabled: false,
          inviteCode,
          antCode: inviteCode,
          shareLink: `https://a-network.net/?ref=${inviteCode}`,
          directReferrals: totalReferrals,
          directReferralsCompleted1k: qualifiedReferrals,
          totalReferralSessions,
          referralProgress,
          mySuccessfulSessions: mySessions,
          levelTargetSessions: 1000,
          myRemainingTo1k: Math.max(0, 1000 - mySessions),
          hasPermanentUpline: !!me.referred_by,
        };
      }).then((payload) => {
        if (payload && payload.__errorCode) {
          return reply.code(payload.__errorCode).send({ error: payload.error });
        }
        return payload;
      });
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to load referral stats' });
    }
  });

  fastify.post('/ant-code/claim', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const antCode = normalizeReferralCode(req.body?.antCode || req.body?.referralCode);
      const preferredScope = normalizeCommunityRoomScope(req.body?.scope);

      if (!antCode) {
        return reply.code(400).send({ error: 'Ant Code is required' });
      }

      const meRes = await db.query(
        `SELECT id, referred_by
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId]
      );

      const me = meRes.rows[0];
      if (!me) {
        return reply.code(404).send({ error: 'User not found' });
      }

      if (me.referred_by) {
        return reply.code(409).send({ error: 'Permanent upline already assigned' });
      }

      const myAntCode = normalizeReferralCode(await ensureUserReferralCode(userId));
      if (antCode === myAntCode) {
        return reply.code(400).send({ error: 'You cannot use your own Ant Code' });
      }

      const ownerRes = await db.query(
        `SELECT id
         FROM users
         WHERE referral_code = $1
         LIMIT 1`,
        [antCode]
      );

      const owner = ownerRes.rows[0];
      if (!owner) {
        return reply.code(404).send({ error: 'Ant Code not found' });
      }

      await db.query(
        `UPDATE users
         SET referred_by = $1,
             updated_at = NOW()
         WHERE id = $2
           AND referred_by IS NULL`,
        [owner.id, userId]
      );

      const room = await getReferralChatContext(userId, preferredScope);
      const messages = await loadReferralChatMessages(room.roomKey, req.body?.limit);

      return {
        success: true,
        message: 'Permanent colony upline assigned',
        antCode,
        eligible: true,
        requiresSignIn: true,
        roomKey: room.roomKey,
        roomOwnerId: room.roomOwnerId,
        roomOwnerLabel: room.roomOwnerLabel,
        roomName: room.roomName,
        accessRole: room.accessRole,
        canEditRoomName: room.isOwner,
        roomNameOptions: REFERRAL_ROOM_NAME_OPTIONS,
        directReferralCount: room.directReferralCount,
        myDirectReferralCount: room.myDirectReferralCount,
        hasUpline: room.hasUpline,
        canClaimAntCode: room.canClaimAntCode,
        myAntCode: room.myAntCode,
        currentScope: room.currentScope,
        availableScopes: room.availableScopes,
        messages: messages.map((message) => ({
          ...message,
          isMine: message.userId === userId,
        })),
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to claim Ant Code' });
    } finally {
      clearAuthReadCacheForUser(req.user.userId);
    }
  });

  fastify.get('/community-chat', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const preferredScope = normalizeCommunityRoomScope(req.query?.scope);
      const cacheVariant = `${preferredScope}:${String(req.query?.limit || '')}`;
      const cacheKey = buildAuthReadCacheKey(userId, 'community-chat', cacheVariant);
      return await getOrLoadAuthReadCache(cacheKey, async () => {
        const room = await getReferralChatContext(userId, preferredScope);
        const messages = await loadReferralChatMessages(room.roomKey, req.query?.limit);
        return {
          eligible: true,
          requiresSignIn: true,
          roomKey: room.roomKey,
          roomOwnerId: room.roomOwnerId,
          roomOwnerLabel: room.roomOwnerLabel,
          roomName: room.roomName,
          accessRole: room.accessRole,
          canEditRoomName: room.isOwner,
          roomNameOptions: REFERRAL_ROOM_NAME_OPTIONS,
          directReferralCount: room.directReferralCount,
          myDirectReferralCount: room.myDirectReferralCount,
          hasUpline: room.hasUpline,
          canClaimAntCode: room.canClaimAntCode,
          myAntCode: room.myAntCode,
          currentScope: room.currentScope,
          availableScopes: room.availableScopes,
          messages: messages.map((message) => ({
            ...message,
            isMine: message.userId === userId,
          })),
        };
      });
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to load community chat' });
    }
  });

  fastify.post('/community-chat', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 12, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const preferredScope = normalizeCommunityRoomScope(req.body?.scope);
      const room = await getReferralChatContext(userId, preferredScope);

      const message = sanitizeText(
        req.body?.message,
        GROUP_CHAT_MAX_MESSAGE_LENGTH
      );

      if (!message) {
        return reply.code(400).send({ error: 'Message cannot be empty' });
      }

      const insertedRes = await db.query(
        `INSERT INTO referral_group_messages (room_key, user_id, message_text)
         VALUES ($1, $2, $3)
         RETURNING id, user_id, message_text, created_at`,
        [room.roomKey, userId, message]
      );

      const userRes = await db.query(
        `SELECT COALESCE(NULLIF(referral_code, ''), 'User ' || id::text) AS sender_label
         FROM users
         WHERE id = $1`,
        [userId]
      );

      const row = insertedRes.rows[0];
      return reply.code(201).send({
        message: {
          id: Number(row.id),
          userId,
          senderLabel: userRes.rows[0]?.sender_label || `User ${userId}`,
          text: row.message_text,
          createdAt: row.created_at,
          isMine: true,
        },
        eligible: true,
        requiresSignIn: true,
        roomKey: room.roomKey,
        roomOwnerId: room.roomOwnerId,
        roomOwnerLabel: room.roomOwnerLabel,
        roomName: room.roomName,
        accessRole: room.accessRole,
        canEditRoomName: room.isOwner,
        directReferralCount: room.directReferralCount,
        myDirectReferralCount: room.myDirectReferralCount,
        hasUpline: room.hasUpline,
        canClaimAntCode: room.canClaimAntCode,
        myAntCode: room.myAntCode,
        currentScope: room.currentScope,
        availableScopes: room.availableScopes,
      });
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to send community message' });
    } finally {
      clearAuthReadCacheForUser(req.user.userId);
    }
  });

  fastify.post('/community-chat/room-name', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const preferredScope = normalizeCommunityRoomScope(req.body?.scope);
      const room = await getReferralChatContext(userId, preferredScope);

      if (!room.isOwner) {
        return reply.code(403).send({ error: 'Only the room owner can rename this group' });
      }

      const roomName = sanitizeText(req.body?.roomName, 80);
      if (!REFERRAL_ROOM_NAME_OPTIONS.includes(roomName)) {
        return reply.code(400).send({
          error: 'Please choose one of the available group names',
          roomNameOptions: REFERRAL_ROOM_NAME_OPTIONS,
        });
      }

      await db.query(
        `UPDATE referral_chat_rooms
         SET room_name = $1,
             updated_at = NOW()
         WHERE room_key = $2`,
        [roomName, room.roomKey]
      );

      return {
        success: true,
        roomKey: room.roomKey,
        roomName,
        roomNameOptions: REFERRAL_ROOM_NAME_OPTIONS,
        roomOwnerId: room.roomOwnerId,
        roomOwnerLabel: room.roomOwnerLabel,
        currentScope: room.currentScope,
        availableScopes: room.availableScopes,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to update room name' });
    }
  });

  fastify.post('/wallet/pin/set', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'pin_set_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }

      const userRes = await db.query('SELECT id, pin_hash FROM users WHERE id = $1 LIMIT 1', [userId]);
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (user.pin_hash) {
        return reply.code(409).send({ success: false, message: 'PIN already set. Use change PIN.' });
      }

      const pinHash = await bcrypt.hash(pin, 10);

      // Fetch seed so we can PIN-encrypt it immediately after setting the PIN.
      const seedRes = await db.query(
        `SELECT wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag
         FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const seedRow = seedRes.rows[0];
      let pinEncFields = {};
      if (seedRow?.wallet_seed_encrypted && seedRow?.wallet_seed_iv && seedRow?.wallet_seed_tag) {
        try {
          const rawSeed = decryptSecret(seedRow.wallet_seed_encrypted, seedRow.wallet_seed_iv, seedRow.wallet_seed_tag);
          const pinEnc = encryptWithPin(rawSeed, pin, userId);
          pinEncFields = {
            wallet_seed_pin_encrypted: pinEnc.encrypted,
            wallet_seed_pin_iv: pinEnc.iv,
            wallet_seed_pin_tag: pinEnc.tag,
          };
        } catch (encErr) {
          console.warn(`[Auth] PIN-encrypt seed on pin/set failed for user ${userId}: ${encErr.message}`);
        }
      }

      await db.query(
        `UPDATE users
         SET pin_hash = $1,
             pin_enabled = TRUE,
             wallet_seed_pin_encrypted = COALESCE($3, wallet_seed_pin_encrypted),
             wallet_seed_pin_iv        = COALESCE($4, wallet_seed_pin_iv),
             wallet_seed_pin_tag       = COALESCE($5, wallet_seed_pin_tag),
             updated_at = NOW()
         WHERE id = $2`,
        [
          pinHash,
          userId,
          pinEncFields.wallet_seed_pin_encrypted ?? null,
          pinEncFields.wallet_seed_pin_iv ?? null,
          pinEncFields.wallet_seed_pin_tag ?? null,
        ]
      );

      await logAudit(db, {
        eventType: 'pin_set',
        userId,
        ip: req.ip,
        details: { via: 'wallet_settings' },
      });

      return { success: true, message: 'PIN set successfully' };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to set PIN' });
    }
  });

  fastify.post('/wallet/pin/change', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const currentPin = sanitizeText(req.body?.currentPin || '', 16);
      const newPin = sanitizeText(req.body?.newPin || '', 16);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'pin_change_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidPin(currentPin) || !isValidPin(newPin)) {
        return reply.code(400).send({ success: false, message: 'Invalid PIN format' });
      }

      const userRes = await db.query('SELECT id, pin_hash FROM users WHERE id = $1 LIMIT 1', [userId]);
      const user = userRes.rows[0];
      if (!user || !user.pin_hash) {
        return reply.code(404).send({ success: false, message: 'PIN is not set' });
      }

      const valid = await bcrypt.compare(currentPin, user.pin_hash);
      if (!valid) {
        return reply.code(401).send({ success: false, message: 'Current PIN is invalid' });
      }

      const pinHash = await bcrypt.hash(newPin, 10);

      // Re-encrypt seed with the new PIN key.
      const seedRes = await db.query(
        `SELECT wallet_seed_pin_encrypted, wallet_seed_pin_iv, wallet_seed_pin_tag,
                wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag
         FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const seedRow = seedRes.rows[0];
      let pinEncFields = {};
      try {
        let rawSeed = null;
        // Prefer decrypting existing PIN-encrypted copy with the old PIN.
        if (seedRow?.wallet_seed_pin_encrypted && seedRow?.wallet_seed_pin_iv && seedRow?.wallet_seed_pin_tag) {
          rawSeed = decryptWithPin(
            seedRow.wallet_seed_pin_encrypted,
            seedRow.wallet_seed_pin_iv,
            seedRow.wallet_seed_pin_tag,
            currentPin,
            userId,
          );
        } else if (seedRow?.wallet_seed_encrypted && seedRow?.wallet_seed_iv && seedRow?.wallet_seed_tag) {
          // Fall back to server-key decrypt for users who set PIN before this feature.
          rawSeed = decryptSecret(seedRow.wallet_seed_encrypted, seedRow.wallet_seed_iv, seedRow.wallet_seed_tag);
        }
        if (rawSeed) {
          const pinEnc = encryptWithPin(rawSeed, newPin, userId);
          pinEncFields = {
            wallet_seed_pin_encrypted: pinEnc.encrypted,
            wallet_seed_pin_iv: pinEnc.iv,
            wallet_seed_pin_tag: pinEnc.tag,
          };
        }
      } catch (encErr) {
        console.warn(`[Auth] Re-encrypt seed on pin/change failed for user ${userId}: ${encErr.message}`);
      }

      await db.query(
        `UPDATE users
         SET pin_hash = $1,
             pin_enabled = TRUE,
             wallet_seed_pin_encrypted = COALESCE($3, wallet_seed_pin_encrypted),
             wallet_seed_pin_iv        = COALESCE($4, wallet_seed_pin_iv),
             wallet_seed_pin_tag       = COALESCE($5, wallet_seed_pin_tag),
             updated_at = NOW()
         WHERE id = $2`,
        [
          pinHash,
          userId,
          pinEncFields.wallet_seed_pin_encrypted ?? null,
          pinEncFields.wallet_seed_pin_iv ?? null,
          pinEncFields.wallet_seed_pin_tag ?? null,
        ]
      );

      await logAudit(db, {
        eventType: 'pin_changed',
        userId,
        ip: req.ip,
      });

      return { success: true, message: 'PIN changed successfully' };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to change PIN' });
    }
  });

  fastify.post('/wallet/pin/verify', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
      allowTokenOnlyAuthOnDbPressure: true,
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }

      const userRes = await db.readQuery(
        'SELECT id, pin_hash, pin_enabled FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (!user.pin_hash || user.pin_enabled !== true) {
        return reply.code(404).send({ success: false, message: 'PIN is not set' });
      }

      const valid = await bcrypt.compare(pin, user.pin_hash);
      if (!valid) {
        try {
          await logAudit(db, {
            eventType: 'pin_verify_failed',
            userId,
            ip: req.ip,
          });
        } catch (_) {}
        return reply.code(401).send({ success: false, message: 'PIN is invalid' });
      }

      try {
        await logAudit(db, {
          eventType: 'pin_verified',
          userId,
          ip: req.ip,
        });
      } catch (_) {}

      return { success: true, message: 'PIN verified' };
    } catch (err) {
      if (isDbConnectTimeoutError(err)) {
        return reply.code(503).send({ success: false, message: 'Service busy, please retry.' });
      }
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to verify PIN' });
    }
  });

  fastify.post('/wallet/pin/forgot/request', {
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const email = sanitizeText(req.body?.email || '', 255).toLowerCase();
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'pin_reset_request_blocked_insecure_runtime',
        email,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidEmail(email)) {
        return reply.code(400).send({ success: false, message: 'Invalid email format' });
      }

      const userRes = await db.query(
        `SELECT id, email, pin_hash
         FROM users
         WHERE email = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [email]
      );
      const user = userRes.rows[0];

      if (!user || !user.pin_hash) {
        return { success: true, message: 'If this account exists, a PIN reset code was sent.' };
      }

      const otp = crypto.randomInt(100000, 1000000).toString();
      const otpHash = await bcrypt.hash(otp, 10);
      await db.query(
        `UPDATE users
         SET pin_reset_otp_hash = $1,
             pin_reset_otp_expiry = NOW() + ($2 || ' minutes')::interval,
             pin_reset_otp_attempts = 0
         WHERE id = $3`,
        [otpHash, PIN_RESET_TTL_MINUTES, user.id]
      );

      await sendSimpleOtpEmail(
        user.email,
        otp,
        'A-Network PIN reset code',
        'A-Network PIN Reset',
        PIN_RESET_TTL_MINUTES
      );

      return {
        success: true,
        message: 'PIN reset code sent to your email',
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to request PIN reset' });
    }
  });

  fastify.post('/wallet/pin/forgot/confirm', {
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const email = sanitizeText(req.body?.email || '', 255).toLowerCase();
      const otp = sanitizeText(req.body?.otp || '', 10);
      const newPin = sanitizeText(req.body?.newPin || '', 16);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'pin_reset_confirm_blocked_insecure_runtime',
        email,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!isValidEmail(email) || !isValidOtp(otp) || !isValidPin(newPin)) {
        return reply.code(400).send({ success: false, message: 'Invalid input' });
      }

      const userRes = await db.query(
        `SELECT id, pin_reset_otp_hash, pin_reset_otp_expiry, pin_reset_otp_attempts
         FROM users
         WHERE email = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [email]
      );
      const user = userRes.rows[0];
      if (!user || !user.pin_reset_otp_hash || !user.pin_reset_otp_expiry) {
        return reply.code(400).send({ success: false, message: 'No active PIN reset code found' });
      }

      if (Number(user.pin_reset_otp_attempts || 0) >= OTP_MAX_ATTEMPTS) {
        return reply.code(429).send({ success: false, message: 'PIN reset attempts exceeded. Request a new code.' });
      }
      if (new Date(user.pin_reset_otp_expiry) < new Date()) {
        return reply.code(400).send({ success: false, message: 'PIN reset code expired' });
      }

      const validOtp = await bcrypt.compare(otp, user.pin_reset_otp_hash);
      if (!validOtp) {
        await db.query(
          `UPDATE users
           SET pin_reset_otp_attempts = COALESCE(pin_reset_otp_attempts, 0) + 1
           WHERE id = $1`,
          [user.id]
        );
        return reply.code(401).send({ success: false, message: 'Invalid PIN reset code' });
      }

      const pinHash = await bcrypt.hash(newPin, 10);

      // Old PIN is unknown, so re-encrypt the seed using the server key as recovery source.
      const seedRes = await db.query(
        `SELECT wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag
         FROM users WHERE id = $1 LIMIT 1`,
        [user.id]
      );
      const seedRow = seedRes.rows[0];
      let pinEncFields = {};
      if (seedRow?.wallet_seed_encrypted && seedRow?.wallet_seed_iv && seedRow?.wallet_seed_tag) {
        try {
          const rawSeed = decryptSecret(seedRow.wallet_seed_encrypted, seedRow.wallet_seed_iv, seedRow.wallet_seed_tag);
          const pinEnc = encryptWithPin(rawSeed, newPin, user.id);
          pinEncFields = {
            wallet_seed_pin_encrypted: pinEnc.encrypted,
            wallet_seed_pin_iv: pinEnc.iv,
            wallet_seed_pin_tag: pinEnc.tag,
          };
        } catch (encErr) {
          console.warn(`[Auth] Re-encrypt seed on pin/forgot/confirm failed for user ${user.id}: ${encErr.message}`);
        }
      }

      await db.query(
        `UPDATE users
         SET pin_hash = $1,
             pin_enabled = TRUE,
             pin_reset_otp_hash = NULL,
             pin_reset_otp_expiry = NULL,
             pin_reset_otp_attempts = 0,
             wallet_seed_pin_encrypted = COALESCE($3, wallet_seed_pin_encrypted),
             wallet_seed_pin_iv        = COALESCE($4, wallet_seed_pin_iv),
             wallet_seed_pin_tag       = COALESCE($5, wallet_seed_pin_tag),
             updated_at = NOW()
         WHERE id = $2`,
        [
          pinHash,
          user.id,
          pinEncFields.wallet_seed_pin_encrypted ?? null,
          pinEncFields.wallet_seed_pin_iv ?? null,
          pinEncFields.wallet_seed_pin_tag ?? null,
        ]
      );

      await logAudit(db, {
        eventType: 'pin_reset_confirmed',
        userId: user.id,
        ip: req.ip,
      });

      return { success: true, message: 'PIN reset successful' };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to reset PIN' });
    }
  });

  fastify.post('/wallet/seed/request-otp', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'seed_view_request_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      const userRes = await db.query(
        `SELECT id, email, pin_hash
         FROM users
         WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (!user.pin_hash) {
        return reply.code(400).send({ success: false, message: 'Set your PIN first to protect seed phrase' });
      }

      const validPin = await bcrypt.compare(pin, user.pin_hash);
      if (!validPin) {
        return reply.code(401).send({ success: false, message: 'Invalid PIN' });
      }

      const otp = crypto.randomInt(100000, 1000000).toString();
      const otpHash = await bcrypt.hash(otp, 10);
      await db.query(
        `UPDATE users
         SET seed_view_otp_hash = $1,
             seed_view_otp_expiry = NOW() + ($2 || ' minutes')::interval,
             seed_view_otp_attempts = 0
         WHERE id = $3`,
        [otpHash, OTP_TTL_MINUTES, user.id]
      );

      await sendSimpleOtpEmail(
        user.email,
        otp,
        'A-Network account security code',
        'A-Network Account Security Check',
        OTP_TTL_MINUTES
      );

      await logAudit(db, {
        eventType: 'seed_view_otp_requested',
        userId,
        ip: req.ip,
      });

      return {
        success: true,
        message: 'Verification code sent to your email',
        debugOtp: OTP_DEBUG_MODE ? otp : undefined,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to send verification code' });
    }
  });

  fastify.post('/wallet/seed/reveal', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const otp = sanitizeText(req.body?.otp || '', 10);

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }
      if (SEED_OTP_REQUIRED && !isValidOtp(otp)) {
        return reply.code(400).send({ success: false, message: 'OTP code is required' });
      }

      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'seed_reveal_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      let userRes;
      try {
        userRes = await db.query(
          `SELECT id, pin_hash,
                  wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag, wallet_seed_key_version, wallet_passphrase,
                  wallet_seed_pin_encrypted, wallet_seed_pin_iv, wallet_seed_pin_tag,
                  seed_view_otp_hash, seed_view_otp_expiry, seed_view_otp_attempts
           FROM users
           WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
           LIMIT 1`,
          [userId]
        );
      } catch (dbErr) {
        console.error(`[Auth] reveal: user SELECT failed for ${userId}: ${dbErr.message}`);
        return reply.code(503).send({ success: false, message: 'Wallet store temporarily unavailable. Try again shortly.' });
      }
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (!user.pin_hash) {
        return reply.code(400).send({ success: false, message: 'Set your PIN first to protect seed phrase' });
      }

      const validPin = await bcrypt.compare(pin, user.pin_hash);
      if (!validPin) {
        return reply.code(401).send({ success: false, message: 'Invalid PIN' });
      }

      if (SEED_OTP_REQUIRED) {
        if (!isValidOtp(otp)) {
          return reply.code(400).send({ success: false, message: 'OTP code is required' });
        }
        if (!user.seed_view_otp_hash || !user.seed_view_otp_expiry) {
          return reply.code(400).send({ success: false, message: 'Request OTP first' });
        }
        if (Number(user.seed_view_otp_attempts || 0) >= OTP_MAX_ATTEMPTS) {
          return reply.code(429).send({ success: false, message: 'OTP attempts exceeded. Request a new code.' });
        }
        if (new Date(user.seed_view_otp_expiry) < new Date()) {
          return reply.code(400).send({ success: false, message: 'OTP expired. Request a new code.' });
        }

        const validOtp = await bcrypt.compare(otp, user.seed_view_otp_hash);
        if (!validOtp) {
          await db.query(
            `UPDATE users
             SET seed_view_otp_attempts = COALESCE(seed_view_otp_attempts, 0) + 1
             WHERE id = $1`,
            [userId]
          );
          return reply.code(401).send({ success: false, message: 'Invalid OTP code' });
        }
      }

      let encryptedSeed = user.wallet_seed_encrypted;
      let encryptedIv = user.wallet_seed_iv;
      let encryptedTag = user.wallet_seed_tag;

      if ((!encryptedSeed || !encryptedIv || !encryptedTag) && user.wallet_passphrase) {
        try {
          const migratedSeed = encryptSecret(user.wallet_passphrase);
          await db.query(
            `UPDATE users
             SET wallet_seed_encrypted   = $1,
                 wallet_seed_iv          = $2,
                 wallet_seed_tag         = $3,
                 wallet_seed_key_version = 2,
                 wallet_passphrase       = NULL,
                 updated_at              = NOW()
             WHERE id = $4`,
            [migratedSeed.encrypted, migratedSeed.iv, migratedSeed.tag, userId]
          );
          encryptedSeed = migratedSeed.encrypted;
          encryptedIv = migratedSeed.iv;
          encryptedTag = migratedSeed.tag;
        } catch (migrationErr) {
          console.warn(`[Auth] Failed on-demand seed migration for user ${userId}: ${migrationErr.message || migrationErr}`);
        }
      }

      if (!encryptedSeed || !encryptedIv || !encryptedTag) {
        return {
          success: true,
          seedPhrase: null,
          localSeedFallback: true,
          message: 'No server seed phrase found. If this device still has your older local backup, the app can reveal it after verification.',
        };
      }

      let seedPhrase = null;
      let decryptedVia = null; // 'pin' | 'server'
      let keyVersionUsed = null;

      // Path 1: decrypt with PIN-derived key (server never holds plaintext).
      if (user.wallet_seed_pin_encrypted && user.wallet_seed_pin_iv && user.wallet_seed_pin_tag) {
        try {
          seedPhrase = decryptWithPin(
            user.wallet_seed_pin_encrypted,
            user.wallet_seed_pin_iv,
            user.wallet_seed_pin_tag,
            pin,
            userId,
          );
          decryptedVia = 'pin';
        } catch (pinErr) {
          // PIN-encrypted copy is stale (e.g., user changed PIN, or it was
          // written with a different PIN during an earlier migration).
          // Fall through to the server-key path below and re-stamp the PIN copy.
          console.warn(`[Auth] reveal: PIN decrypt failed for user ${userId}, falling back to server key`);
        }
      }

      // Path 2: server-key decrypt (with v1/interim fallback inside decryptSecretEx).
      let serverDecryptFailed = false;
      if (!seedPhrase) {
        try {
          const dec = decryptSecretEx(encryptedSeed, encryptedIv, encryptedTag, user.wallet_seed_key_version);
          seedPhrase = dec.plaintext;
          keyVersionUsed = dec.keyVersionUsed;
          decryptedVia = 'server';
        } catch (serverErr) {
          // The server-side ciphertext can't be decrypted with any known key.
          // This affects users whose row was written during a deploy window
          // with a key that is no longer in env (see v99 cohort). Do NOT 500
          // — fall through so the client can recover from its on-device
          // local backup and (optionally) heal the server via /wallet/seed/backup.
          console.warn(`[Auth] reveal: server-key decrypt failed for user ${userId} (key_version=${user.wallet_seed_key_version}): ${serverErr.message}`);
          serverDecryptFailed = true;
        }
      }

      // If both PIN-decrypt and server-decrypt failed, the server cannot
      // produce the seed. Return a structured fallback response so the
      // mobile client can use its local backup (and self-heal via
      // /wallet/seed/backup if it has one).
      if (!seedPhrase && serverDecryptFailed) {
        await logAudit(db, {
          eventType: 'seed_reveal_server_corrupt',
          userId,
          ip: req.ip,
          details: { keyVersion: user.wallet_seed_key_version },
        });
        return {
          success: true,
          seedPhrase: null,
          localSeedFallback: true,
          serverSeedCorrupt: true,
          message: 'Your server-side backup is unreadable on this server. If this device still has your original seed phrase, the app can show it and re-upload it as a fresh backup.',
        };
      }

      // If we decrypted with a legacy key (v1 placeholder or interim deploy-
      // window hash), re-encrypt the row with the current v2 key so the next
      // reveal goes straight through path 2 with no fallback.
      if (decryptedVia === 'server' && keyVersionUsed !== 2) {
        try {
          const reEnc = encryptSecret(seedPhrase);
          await db.query(
            `UPDATE users
             SET wallet_seed_encrypted   = $1,
                 wallet_seed_iv          = $2,
                 wallet_seed_tag         = $3,
                 wallet_seed_key_version = 2,
                 updated_at              = NOW()
             WHERE id = $4`,
            [reEnc.encrypted, reEnc.iv, reEnc.tag, userId]
          );
          console.log(`[Auth] reveal: re-encrypted user ${userId} from key_version=${keyVersionUsed} to v2`);
        } catch (reEncErr) {
          console.warn(`[Auth] reveal: lazy v2 re-encrypt failed for user ${userId}: ${reEncErr.message}`);
        }
      }

      // Always refresh / create the PIN-encrypted copy so it matches the
      // PIN the user just typed (handles stale-PIN-copy case from path 1).
      try {
        const pinEnc = encryptWithPin(seedPhrase, pin, userId);
        await db.query(
          `UPDATE users
           SET wallet_seed_pin_encrypted = $1,
               wallet_seed_pin_iv        = $2,
               wallet_seed_pin_tag       = $3,
               updated_at = NOW()
           WHERE id = $4`,
          [pinEnc.encrypted, pinEnc.iv, pinEnc.tag, userId]
        );
      } catch (lazyErr) {
        console.warn(`[Auth] Lazy PIN-encrypt failed for user ${userId}: ${lazyErr.message}`);
      }

      await db.query(
        `UPDATE users
         SET seed_view_otp_hash = NULL,
             seed_view_otp_expiry = NULL,
             seed_view_otp_attempts = 0
         WHERE id = $1`,
        [userId]
      );

      await logAudit(db, {
        eventType: 'seed_revealed',
        userId,
        ip: req.ip,
        details: { otpRequired: SEED_OTP_REQUIRED },
      });

      return {
        success: true,
        seedPhrase,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to reveal seed phrase' });
    }
  });

  /**
   * PIN-only seed reveal for DEX signing context.
   * Unlike /wallet/seed/reveal this does NOT require OTP — the seed is used
   * ephemerally on-device to sign a single DEX transaction and is never stored
   * or displayed to the user.  JWT + PIN provide sufficient auth for this flow.
   */
  fastify.post('/wallet/seed/reveal-for-dex', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }

      const userRes = await db.query(
        `SELECT id, pin_hash,
                wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag, wallet_passphrase,
                wallet_seed_pin_encrypted, wallet_seed_pin_iv, wallet_seed_pin_tag
         FROM users
         WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (!user.pin_hash) {
        return reply.code(400).send({ success: false, message: 'Set your PIN first' });
      }

      const validPin = await bcrypt.compare(pin, user.pin_hash);
      if (!validPin) {
        try {
          await logAudit(db, { eventType: 'pin_verify_failed', userId, ip: req.ip });
        } catch (_) {}
        return reply.code(401).send({ success: false, message: 'Invalid PIN' });
      }

      let seedPhrase = null;
      let keyVersionUsed = null;

      // Path 1: PIN-encrypted copy.
      if (user.wallet_seed_pin_encrypted && user.wallet_seed_pin_iv && user.wallet_seed_pin_tag) {
        try {
          seedPhrase = decryptWithPin(
            user.wallet_seed_pin_encrypted,
            user.wallet_seed_pin_iv,
            user.wallet_seed_pin_tag,
            pin,
            userId,
          );
        } catch (decryptErr) {
          // Stale PIN copy — fall through to server-key path instead of
          // hard-failing. The user's PIN was already verified above.
          console.warn(`[Auth] reveal-for-dex: PIN decrypt failed for user ${userId}, trying server key`);
        }
      }

      // Path 2: server-key decrypt (with v1/interim fallback).
      let serverDecryptFailed = false;
      if (!seedPhrase && user.wallet_seed_encrypted && user.wallet_seed_iv && user.wallet_seed_tag) {
        try {
          const dec = decryptSecretEx(user.wallet_seed_encrypted, user.wallet_seed_iv, user.wallet_seed_tag, user.wallet_seed_key_version);
          seedPhrase = dec.plaintext;
          keyVersionUsed = dec.keyVersionUsed;
        } catch (decryptErr) {
          // The server-side ciphertext can't be decrypted with any known key.
          // Do NOT auto-regenerate a new wallet — that would silently change
          // wallet_address and orphan any existing balance. Surface a clear
          // 409 so the client can recover from its on-device backup via
          // /wallet/seed/backup.
          console.warn(`[Auth] reveal-for-dex decrypt failed for user ${userId} (key_version=${user.wallet_seed_key_version}): ${decryptErr.message}`);
          serverDecryptFailed = true;
        }
      }

      // Path 3: ancient unencrypted passphrase column.
      if (!seedPhrase && user.wallet_passphrase) {
        seedPhrase = user.wallet_passphrase;
      }

      // Lazy re-encrypt to v2 if a legacy key was used.
      if (seedPhrase && keyVersionUsed && keyVersionUsed !== 2) {
        try {
          const reEnc = encryptSecret(seedPhrase);
          await db.query(
            `UPDATE users
             SET wallet_seed_encrypted   = $1,
                 wallet_seed_iv          = $2,
                 wallet_seed_tag         = $3,
                 wallet_seed_key_version = 2,
                 updated_at              = NOW()
             WHERE id = $4`,
            [reEnc.encrypted, reEnc.iv, reEnc.tag, userId]
          );
          console.log(`[Auth] reveal-for-dex: re-encrypted user ${userId} from key_version=${keyVersionUsed} to v2`);
        } catch (reEncErr) {
          console.warn(`[Auth] reveal-for-dex: lazy v2 re-encrypt failed for user ${userId}: ${reEncErr.message}`);
        }
      }

      // Always refresh PIN copy so next reveal hits path 1 cleanly.
      if (seedPhrase) {
        try {
          const pinEnc = encryptWithPin(seedPhrase, pin, userId);
          await db.query(
            `UPDATE users
             SET wallet_seed_pin_encrypted = $1,
                 wallet_seed_pin_iv        = $2,
                 wallet_seed_pin_tag       = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [pinEnc.encrypted, pinEnc.iv, pinEnc.tag, userId]
          );
        } catch (lazyErr) {
          console.warn(`[Auth] reveal-for-dex lazy PIN-encrypt failed for user ${userId}: ${lazyErr.message}`);
        }
      }

      if (!seedPhrase) {
        // No usable seed on the server. We deliberately do NOT auto-create
        // a new wallet here — that would silently change wallet_address
        // and could orphan any balance attached to the original address.
        // The client should prompt the user to restore from their on-device
        // local backup and call /wallet/seed/backup to heal the server copy.
        await logAudit(db, {
          eventType: serverDecryptFailed ? 'dex_seed_server_corrupt' : 'dex_seed_missing',
          userId,
          ip: req.ip,
          details: { keyVersion: user.wallet_seed_key_version, serverDecryptFailed },
        });
        return reply.code(409).send({
          success: false,
          serverSeedCorrupt: serverDecryptFailed,
          localSeedFallback: true,
          message: 'Your wallet seed is not available on the server. Open the wallet screen and tap Reveal — if this device has a saved backup it restores and re-backs it up automatically; if not, choose “Create new wallet” there to recover your account (your balance and history are kept).',
        });
      }

      await logAudit(db, {
        eventType: 'seed_revealed_for_dex',
        userId,
        ip: req.ip,
      });

      return { success: true, seedPhrase };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to retrieve seed for DEX' });
    }
  });

  /**
   * ────────────────────────────────────────────────────────────────────
   * EVM key derivation for the swap / DEX flow.
   *
   * The wallet seed stored on the server is a BIP-39 mnemonic. The legacy
   * `seedToPrivateKey()` helper returns sha256(mnemonic) which is NOT a
   * MetaMask-compatible EVM key and cannot sign txs the chain will accept.
   * These two routes derive the proper m/44'/60'/0'/0/0 EVM key so the
   * swap UI can show the user's real EVM address and sign EVM swap txs.
   *
   * Auth model:
   *   - GET /wallet/evm/address      : JWT only.  Returns the public EVM
   *                                    address. No secret leaves the server.
   *   - POST /wallet/evm/keys        : JWT + PIN. Returns address AND the
   *                                    32-byte private key (0x-hex) so the
   *                                    client can sign a single swap tx
   *                                    on-device. Same gate as
   *                                    /wallet/seed/reveal-for-dex.
   * ────────────────────────────────────────────────────────────────────
   */
  async function _loadAndDecryptSeed(userId, pin) {
    const userRes = await db.query(
      `SELECT id, pin_hash,
              wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag, wallet_seed_key_version, wallet_passphrase,
              wallet_seed_pin_encrypted, wallet_seed_pin_iv, wallet_seed_pin_tag
       FROM users
       WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
       LIMIT 1`,
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) return { error: { code: 404, message: 'User not found' } };

    if (pin != null) {
      if (!user.pin_hash) return { error: { code: 400, message: 'Set your PIN first' } };
      const ok = await bcrypt.compare(pin, user.pin_hash);
      if (!ok) return { error: { code: 401, message: 'Invalid PIN' } };
    }

    let seed = null;

    if (pin && user.wallet_seed_pin_encrypted && user.wallet_seed_pin_iv && user.wallet_seed_pin_tag) {
      try {
        seed = decryptWithPin(
          user.wallet_seed_pin_encrypted,
          user.wallet_seed_pin_iv,
          user.wallet_seed_pin_tag,
          pin,
          userId,
        );
      } catch (_) { /* fall through */ }
    }

    if (!seed && user.wallet_seed_encrypted && user.wallet_seed_iv && user.wallet_seed_tag) {
      try {
        const dec = decryptSecretEx(
          user.wallet_seed_encrypted,
          user.wallet_seed_iv,
          user.wallet_seed_tag,
          user.wallet_seed_key_version,
        );
        seed = dec.plaintext;
      } catch (e) {
        return {
          error: {
            code: 409,
            body: {
              success: false,
              serverSeedCorrupt: true,
              localSeedFallback: true,
              message: 'Your wallet seed is not readable on the server. Open the wallet screen and tap Reveal — if this device has a saved backup it restores automatically; if not, choose “Create new wallet” there to recover your account (your balance and history are kept).',
            },
          },
        };
      }
    }

    if (!seed && user.wallet_passphrase) seed = user.wallet_passphrase;
    if (!seed) {
      return {
        error: {
          code: 409,
          body: {
            success: false,
            localSeedFallback: true,
            message: 'No server backup found for your wallet seed. Open the wallet screen and tap Reveal to restore from this device’s backup; if none exists, choose “Create new wallet” there to recover your account.',
          },
        },
      };
    }
    return { seed };
  }

  fastify.get('/wallet/evm/address', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const loaded = await _loadAndDecryptSeed(userId, null);
      if (loaded.error) {
        const e = loaded.error;
        return reply.code(e.code).send(e.body || { success: false, message: e.message });
      }
      let evm;
      try {
        evm = mnemonicToEvm(loaded.seed, 0);
      } catch (deriveErr) {
        console.error(`[Auth] evm/address derive failed for ${userId}: ${deriveErr.message}`);
        return reply.code(500).send({ success: false, message: deriveErr.message });
      }
      return { success: true, address: evm.address, path: evm.path };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to derive EVM address' });
    }
  });

  fastify.post('/wallet/evm/keys', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const accountIndex = Math.max(0, Number(req.body?.accountIndex || 0));

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }

      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'evm_keys_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) return runtimeCheck.response;

      const loaded = await _loadAndDecryptSeed(userId, pin);
      if (loaded.error) {
        const e = loaded.error;
        return reply.code(e.code).send(e.body || { success: false, message: e.message });
      }

      let evm;
      try {
        evm = mnemonicToEvm(loaded.seed, accountIndex);
      } catch (deriveErr) {
        console.error(`[Auth] evm/keys derive failed for ${userId}: ${deriveErr.message}`);
        return reply.code(500).send({ success: false, message: deriveErr.message });
      }

      await logAudit(db, {
        eventType: 'evm_keys_revealed_for_swap',
        userId,
        ip: req.ip,
        details: { accountIndex },
      });

      return {
        success: true,
        address: evm.address,
        privateKey: evm.privateKey,
        publicKey: evm.publicKey,
        path: evm.path,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to derive EVM keys' });
    }
  });

  /**
   * ────────────────────────────────────────────────────────────────────
   * Legacy → secp wallet migration (server-side, automated)
   *
   * Root cause of "signature recovery does not match action wallet":
   *   The user's on-chain wallet was originally derived as
   *   `RIPEMD160(SHA256(hex_lower(secp_privkey)))` — a "legacy" address
   *   that cannot be the recovered signer of any secp ECDSA signature.
   *   When the mobile app signs a dex_swap / bridge_burn action with the
   *   real secp key derived from the seed, the chain recovers the secp
   *   ANET address — which is NOT the legacy address — and rejects.
   *
   * Fix: run the chain's commit-reveal migration to sweep the legacy
   * balance into the secp address, then update users.wallet_address.
   * Idempotent — safe to call repeatedly; returns "already_migrated".
   *
   * Auth: JWT + PIN. The PIN is required because we must decrypt the
   * seed to derive the secp private key.
   *
   * Env:
   *   ANET_L1_BASE_URL  base URL of the L1 node
   *                     (default: https://explorer.a-network.net)
   *   ANET_CHAIN_ID     chain id used in signed actions
   *                     (default: anet-private-mainnet-1)
   * ────────────────────────────────────────────────────────────────────
   */
  const ANET_L1_BASE_URL = String(process.env.ANET_L1_BASE_URL || 'https://explorer.a-network.net').replace(/\/+$/, '');
  const ANET_CHAIN_ID = String(process.env.ANET_CHAIN_ID || 'anet-private-mainnet-1');
  // Admin key used to clear a stuck (committed-but-not-revealed) migration
  // row when the original commit nonce is unrecoverable. The chain accepts
  // ANET_MIGRATION_ADMIN_KEY and falls back to ANET_DEX_ADMIN_KEY, so we
  // mirror that here. When present the bridge self-heals an orphan commit
  // instead of dead-ending the user at "contact support".
  const ANET_MIGRATION_ADMIN_KEY = String(
    process.env.ANET_MIGRATION_ADMIN_KEY || process.env.ANET_DEX_ADMIN_KEY || ''
  ).trim();

  async function _l1Get(path) {
    const res = await fetch(`${ANET_L1_BASE_URL}${path}`, { method: 'GET' });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: res.status, ok: res.ok, body };
  }

  async function _l1Post(path, payload) {
    const res = await fetch(`${ANET_L1_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: res.status, ok: res.ok, body };
  }

  // Self-heal a stuck migration: ask the chain to admin-cancel the
  // committed-but-not-revealed row for `legacyAddr` so the user can
  // immediately retry the commit→reveal flow with a fresh nonce. Returns
  // true only when the stuck row was actually cleared. Requires the
  // migration admin key to be configured on the backend; if it is not,
  // returns false and the caller falls back to the manual-support path.
  async function _l1AdminCancelMigration(legacyAddr, reason) {
    if (!ANET_MIGRATION_ADMIN_KEY) return { ok: false, reason: 'admin_key_unset' };
    const res = await _l1Post('/admin/wallet/migrate-legacy/cancel', {
      legacy_address: legacyAddr,
      admin_key: ANET_MIGRATION_ADMIN_KEY,
      reason: String(reason || 'orphan commit nonce unrecoverable'),
    });
    return { ok: res.ok && res.body && res.body.cancelled === true, status: res.status, body: res.body };
  }

  // Activation gate for value-moving L1 actions (swaps / bridge burns).
  //
  // The chain only activates a wallet — making its balance spendable and
  // bridgeable — once the account has reached MIN_SESSIONS_FOR_ANET mining
  // sessions (1000). If we let a not-yet-activated user sign a dex_swap or
  // bridge_burn, the chain has no spendable balance to move: the action
  // either fails on chain or, worse, debits an inbound bridge credit that
  // lands later, stranding funds. So we refuse to sign until the wallet is
  // activated. The user can always swap again (or bridge back) once the
  // 1000-session threshold is met — nothing is lost, the action is simply
  // deferred. Returns { activated, web2Sessions, sessionsNeeded }.
  const MIN_SESSIONS_FOR_ANET = 1000;
  async function _checkWalletActivation(secpAddr, legacyAddr) {
    // A wallet counts as activated if EITHER its secp (post-migration) or
    // legacy (pre-migration) on-chain account is ACTIVATED or already
    // holds on-chain ANTS.
    let web2Sessions = 0;
    for (const addr of [secpAddr, legacyAddr]) {
      if (!addr) continue;
      const acct = await _l1Get(`/account/full/${addr}`);
      const body = (acct && acct.body) || {};
      const status = String(body.status || '').toUpperCase();
      const onchainAnts = Number((body.onchain && body.onchain.ants_balance) || 0);
      const sessions = Number((body.web2 && body.web2.sessions) || 0);
      if (sessions > web2Sessions) web2Sessions = sessions;
      if (status === 'ACTIVATED' || onchainAnts > 0) {
        return { activated: true, web2Sessions: Math.max(web2Sessions, sessions), sessionsNeeded: 0 };
      }
    }
    return {
      activated: false,
      web2Sessions,
      sessionsNeeded: Math.max(0, MIN_SESSIONS_FOR_ANET - web2Sessions),
    };
  }

  // One-time DDL for the migration commit persistence columns.
  // The chain only stores commit_hash, not the nonce — so if we don't
  // persist the nonce locally we can never reveal a prior commit and the
  // legacy balance is permanently stranded behind the orphan row.
  let _migrationColumnsEnsured = false;
  async function _ensureMigrationColumns() {
    if (_migrationColumnsEnsured) return;
    try {
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_commit_nonce VARCHAR(32)');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_commit_secp VARCHAR(120)');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS migration_commit_at TIMESTAMPTZ');
      _migrationColumnsEnsured = true;
    } catch (e) {
      console.error('[Auth] ensure migration columns failed:', e?.message || e);
    }
  }

  fastify.post('/wallet/migrate-to-secp', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 4, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }

      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'wallet_migrate_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) return runtimeCheck.response;

      const loaded = await _loadAndDecryptSeed(userId, pin);
      if (loaded.error) {
        const e = loaded.error;
        return reply.code(e.code).send(e.body || { success: false, message: e.message });
      }

      // L1 signing key derivation MUST match the mobile app exactly. The
      // mobile client signs every dex_swap / bridge_burn / migrate_*
      // action with privkey = SHA256(seedText) (see
      // main.dart::_deriveAnetPrivateKeyFromSeed). If we used BIP-39
      // (mnemonicToEvm) here we'd migrate balances to a different secp
      // address than the one the mobile signature recovers to, which is
      // exactly the "signature recovery does not match action wallet"
      // error we're fixing. Works for both BIP-39 mnemonic seeds AND
      // legacy passphrase wallets (e.g. ANETBE1255...).
      const l1PrivHex = seedToPrivateKey(loaded.seed); // 64-char lowercase hex, no 0x
      const l1PrivKey0x = '0x' + l1PrivHex;

      const secpAddr = evmPrivKeyToSecpAnetAddress(l1PrivKey0x);
      const legacyAddr = evmPrivKeyToLegacyAnetAddress(l1PrivKey0x);

      await _ensureMigrationColumns();

      // Find the user's current on-chain wallet so we can decide if migration is needed.
      const uRes = await db.query(
        `SELECT id, wallet_address, custom_wallet_address, migration_wallet_address,
                migration_commit_nonce, migration_commit_secp
         FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const u = uRes.rows[0];
      if (!u) return reply.code(404).send({ success: false, message: 'User not found' });

      const currentWallet = String(u.wallet_address || u.custom_wallet_address || '').trim().toUpperCase();

      // If the stored wallet is already the secp address, nothing to do.
      if (currentWallet === secpAddr) {
        return {
          success: true,
          status: 'already_migrated',
          legacy_address: legacyAddr,
          secp_address: secpAddr,
          wallet_address: secpAddr,
        };
      }

      // Check chain state for an existing migration record.
      const existing = await _l1Get(`/wallet/migrate-legacy/${legacyAddr}`);

      // ── ACTIVATION pre-flight ──────────────────────────────────────
      // The chain only knows wallets that have been synced from the
      // web2 ledger, and the sync requires `effective_sessions >=
      // MIN_SESSIONS_FOR_ANET` (currently 1000). If the legacy wallet
      // has never been activated, no commit/reveal can ever succeed
      // because there is nothing to move on chain. Surface a clear
      // message with how many sessions are still needed instead of
      // letting the user create another stuck commit.
      if (!(existing.ok && existing.body && existing.body.status === 'revealed')) {
        const acct = await _l1Get(`/account/full/${legacyAddr}`);
        const acctBody = (acct && acct.body) || {};
        const acctStatus = String(acctBody.status || '').toUpperCase();
        const web2Sessions = Number((acctBody.web2 && acctBody.web2.sessions) || 0);
        const onchainAnts = Number((acctBody.onchain && acctBody.onchain.ants_balance) || 0);
        const MIN_SESSIONS_FOR_ANET = 1000;
        if (acctStatus !== 'ACTIVATED' && onchainAnts === 0) {
          const sessionsNeeded = Math.max(0, MIN_SESSIONS_FOR_ANET - web2Sessions);
          await logAudit(db, {
            eventType: 'wallet_migrate_blocked_not_activated',
            userId, ip: req.ip,
            details: { legacyAddr, secpAddr, web2Sessions, sessionsNeeded, acctStatus },
          });
          return reply.code(409).send({
            success: false,
            phase: 'pre_flight',
            status: 'not_activated_yet',
            message:
              `Your wallet has ${web2Sessions} mining session` +
              `${web2Sessions === 1 ? '' : 's'} so far. ` +
              `You need ${sessionsNeeded} more (total ${MIN_SESSIONS_FOR_ANET}) ` +
              `before the chain activates your account. Keep mining — ` +
              `once activated your balance becomes spendable and DEX swaps will work.`,
            current_sessions: web2Sessions,
            sessions_needed: sessionsNeeded,
            min_sessions_for_activation: MIN_SESSIONS_FOR_ANET,
            legacy_address: legacyAddr,
            secp_address: secpAddr,
            waitlist_available: true,
          });
        }
      }

      if (existing.ok && existing.body && existing.body.status === 'revealed') {
        // Already migrated on chain — just sync the DB.
        await db.query(
          `UPDATE users
           SET wallet_address = $1,
               migration_wallet_address = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [secpAddr, legacyAddr, userId]
        );
        await logAudit(db, { eventType: 'wallet_migrate_synced', userId, ip: req.ip, details: { legacyAddr, secpAddr } });
        return {
          success: true,
          status: 'synced_from_chain',
          legacy_address: legacyAddr,
          secp_address: secpAddr,
          wallet_address: secpAddr,
        };
      }

      // ── COMMIT phase ───────────────────────────────────────────────
      // The chain stores commit_hash = SHA256(privhex:secp:nonce) but NOT
      // the nonce itself. We MUST persist the nonce locally before the
      // commit lands on chain so that any retry (network drop, app close,
      // 502, etc.) can re-use the exact same nonce on reveal. Otherwise
      // the commit row becomes a permanent orphan that cannot be revealed
      // and the legacy balance is stranded.
      const privHexLower = l1PrivHex;
      const chainCommitted =
        existing.ok && existing.body &&
        existing.body.status === 'committed' &&
        String(existing.body.secp_address || '').toUpperCase() === secpAddr;

      let nonce;
      let commitHash;
      let doFreshCommit = !chainCommitted;

      if (chainCommitted) {
        // A prior commit exists on chain. Re-use the stored nonce.
        const storedNonce = String(u.migration_commit_nonce || '').trim();
        const storedSecp  = String(u.migration_commit_secp  || '').trim().toUpperCase();

        // Decide whether the stored nonce can still reproduce the
        // on-chain commit_hash. If not, the commit is an orphan that can
        // never be revealed.
        let orphanReason = null;
        if (!storedNonce || storedSecp !== secpAddr) {
          orphanReason = 'nonce_lost';
        } else {
          nonce = BigInt(storedNonce);
          const preimage = `${privHexLower}:${secpAddr}:${nonce}`;
          commitHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'utf8')).digest('hex');
          if (commitHash !== String(existing.body.commit_hash || '').toLowerCase()) {
            orphanReason = 'nonce_mismatch';
          }
        }

        if (orphanReason) {
          // Self-heal: the chain holds a committed-but-unrevealable row.
          // Following the chain's Bitcoin-style commit→reveal recovery
          // path, ask the node to admin-cancel the stuck commit, then
          // fall through to a brand-new commit→reveal with a fresh nonce.
          // This is safe — cancel only deletes 'committed' rows (never
          // 'revealed' ones) and no balance has moved yet, so nothing is
          // lost and the user's funds will migrate on retry.
          await logAudit(db, {
            eventType: orphanReason === 'nonce_mismatch'
              ? 'wallet_migrate_nonce_mismatch'
              : 'wallet_migrate_orphan_commit',
            userId, ip: req.ip,
            details: {
              legacyAddr, secpAddr,
              chain_commit_hash: existing.body.commit_hash,
              chain_committed_at: existing.body.committed_at,
              orphan_reason: orphanReason,
              computed_commit_hash: commitHash || null,
              has_local_nonce: !!storedNonce,
              local_secp: storedSecp || null,
            },
          });

          const cancelled = await _l1AdminCancelMigration(
            legacyAddr,
            `auto-heal orphan migration commit (${orphanReason}) for user ${userId}`
          );

          if (!cancelled.ok) {
            // Admin key unavailable or chain refused the cancel — fall
            // back to the manual support path so the user still has a
            // clear next step instead of a silent failure.
            await logAudit(db, {
              eventType: 'wallet_migrate_autocancel_failed',
              userId, ip: req.ip,
              details: {
                legacyAddr, secpAddr, orphan_reason: orphanReason,
                cancel_status: cancelled.status || null,
                cancel_body: cancelled.body || cancelled.reason || null,
              },
            });
            return reply.code(409).send({
              success: false,
              phase: 'commit',
              status: 'orphan_commit',
              message:
                'A prior migration commit for this wallet is stuck on chain ' +
                'and the original nonce is not recoverable. Contact support ' +
                'to request an admin cancel of the pending migration; once ' +
                'cleared you can retry from the app and your balance will move.',
              legacy_address: legacyAddr,
              secp_address: secpAddr,
              chain_commit_hash: existing.body.commit_hash,
              chain_committed_at: existing.body.committed_at,
            });
          }

          await logAudit(db, {
            eventType: 'wallet_migrate_autocancelled',
            userId, ip: req.ip,
            details: { legacyAddr, secpAddr, orphan_reason: orphanReason },
          });
          // Stale commit cleared — proceed with a fresh commit below.
          nonce = undefined;
          commitHash = undefined;
          doFreshCommit = true;
        }
      }

      if (doFreshCommit) {
        // Fresh commit. Generate a nonce, persist it, then call chain.
        const nonceBuf = crypto.randomBytes(6);
        nonce = BigInt('0x' + nonceBuf.toString('hex'));
        const preimage = `${privHexLower}:${secpAddr}:${nonce}`;
        commitHash = crypto.createHash('sha256').update(Buffer.from(preimage, 'utf8')).digest('hex');

        // Persist BEFORE calling chain so a network failure between the
        // commit landing and our response can still be recovered.
        await db.query(
          `UPDATE users
             SET migration_commit_nonce = $1,
                 migration_commit_secp  = $2,
                 migration_commit_at    = NOW()
           WHERE id = $3`,
          [nonce.toString(), secpAddr, userId]
        );

        const commitAuth = signAnetActionAuth({
          privKeyHex: l1PrivKey0x,
          wallet: secpAddr,
          actionType: 'migrate_commit',
          chainId: ANET_CHAIN_ID,
          payload: { route: 'migrate_commit' },
        });
        const commitRes = await _l1Post('/wallet/migrate-legacy/commit', {
          legacy_address: legacyAddr,
          secp_address: secpAddr,
          commit_hash: commitHash,
          auth: commitAuth,
        });
        if (!commitRes.ok) {
          await logAudit(db, {
            eventType: 'wallet_migrate_commit_failed',
            userId, ip: req.ip,
            details: { status: commitRes.status, body: commitRes.body, legacyAddr, secpAddr },
          });
          return reply.code(502).send({
            success: false,
            phase: 'commit',
            l1Status: commitRes.status,
            message: (commitRes.body && (commitRes.body.error || commitRes.body.message)) || 'L1 rejected commit',
          });
        }
      }

      // ── REVEAL phase ───────────────────────────────────────────────
      const revealAuth = signAnetActionAuth({
        privKeyHex: l1PrivKey0x,
        wallet: secpAddr,
        actionType: 'migrate_reveal',
        chainId: ANET_CHAIN_ID,
        payload: { route: 'migrate_reveal' },
      });
      // Nonce is up to 48 bits (6 random bytes) so it always fits in a
      // JS Number, but cast through string for safety with the BigInt.
      const revealNonce = Number(nonce);
      const revealRes = await _l1Post('/wallet/migrate-legacy/reveal', {
        legacy_address: legacyAddr,
        secp_address: secpAddr,
        privkey_hex: privHexLower,
        nonce: revealNonce,
        auth: revealAuth,
      });
      if (!revealRes.ok) {
        const revealMsg = (revealRes.body && (revealRes.body.error || revealRes.body.message)) || '';
        // Empty-wallet case: the legacy address has no on-chain account
        // yet (never credited, no transactions). The on-chain reveal
        // requires the legacy account to exist before it can move
        // balances. Do NOT auto-persist the secp address to the DB here
        // — a pending BSC→ANET bridge could be about to credit the
        // legacy address, and rewriting the user's wallet_address before
        // that lands would orphan the incoming mint. Surface a clear
        // message so the user knows to wait for inbound funds first.
        if (/legacy account not found/i.test(revealMsg)) {
          await logAudit(db, {
            eventType: 'wallet_migrate_empty_legacy',
            userId, ip: req.ip,
            details: { legacyAddr, secpAddr },
          });
          return reply.code(409).send({
            success: false,
            phase: 'reveal',
            status: 'empty_legacy_account',
            message:
              'Your ANET L1 wallet has no on-chain balance yet. ' +
              'Wait for your inbound bridge (BSC→ANET) to credit, ' +
              'or receive ANET from another wallet, then try again.',
            legacy_address: legacyAddr,
            secp_address: secpAddr,
          });
        }
        await logAudit(db, {
          eventType: 'wallet_migrate_reveal_failed',
          userId, ip: req.ip,
          details: { status: revealRes.status, body: revealRes.body, legacyAddr, secpAddr },
        });
        return reply.code(502).send({
          success: false,
          phase: 'reveal',
          l1Status: revealRes.status,
          message: revealMsg || 'L1 rejected reveal',
        });
      }

      // ── Persist new wallet address ─────────────────────────────────
      // Clear the commit nonce/secp: the reveal has succeeded and the
      // stored values are no longer needed (and would only confuse a
      // future migration if the user ever rotates seeds).
      await db.query(
        `UPDATE users
         SET wallet_address = $1,
             migration_wallet_address = $2,
             migration_commit_nonce = NULL,
             migration_commit_secp  = NULL,
             migration_commit_at    = NULL,
             updated_at = NOW()
         WHERE id = $3`,
        [secpAddr, legacyAddr, userId]
      );

      await logAudit(db, {
        eventType: 'wallet_migrate_completed',
        userId, ip: req.ip,
        details: {
          legacyAddr,
          secpAddr,
          ants_migrated: revealRes.body && revealRes.body.ants_migrated,
          sessions_migrated: revealRes.body && revealRes.body.sessions_migrated,
        },
      });

      // Auto-process any waitlist intents this user has queued. The
      // wallet just became spendable on chain, so any pending swap
      // intents should transition to 'ready' so the next time the user
      // opens the DEX they get a one-tap confirm. Failures here must
      // never block the migration response.
      let waitlistSummary = null;
      try {
        const waitlistMod = require('./waitlist');
        if (waitlistMod && typeof waitlistMod.processForUser === 'function') {
          waitlistSummary = await waitlistMod.processForUser(userId);
        }
      } catch (e) {
        console.warn('[Auth] waitlist auto-process failed (non-fatal):', e?.message || e);
      }

      return {
        success: true,
        status: 'migrated',
        legacy_address: legacyAddr,
        secp_address: secpAddr,
        wallet_address: secpAddr,
        ants_migrated: revealRes.body && revealRes.body.ants_migrated,
        sessions_migrated: revealRes.body && revealRes.body.sessions_migrated,
        new_secp_ants_balance: revealRes.body && revealRes.body.new_secp_ants_balance,
        waitlist: waitlistSummary,
      };
    } catch (err) {
      console.error('[Auth] migrate-to-secp error:', err);
      return reply.code(500).send({ success: false, message: 'Wallet migration failed' });
    }
  });

  /**
   * Server-side action signer for the swap / bridge flows.
   *
   * The mobile DEX screen POSTs:
   *   { pin, actionType: 'dex_swap'|'bridge_burn'|..., payload: {...} }
   * and gets back a ready-to-submit ActionAuth signed by the user's
   * secp256k1 key. This guarantees the signature recovers to the
   * post-migration secp wallet, eliminating the on-device key-handling
   * complexity that caused the earlier "signature recovery" rejections.
   *
   * Auth: JWT + PIN.
   */
  const _ALLOWED_SIGN_ACTIONS = new Set([
    'dex_swap', 'dex_wrap', 'dex_unwrap', 'dex_add_liquidity', 'dex_create_pool',
    'bridge_burn', 'anrc20_transfer', 'anrc20_mint', 'anrc20_create',
    'app_activity', 'validator_heartbeat',
  ]);

  fastify.post('/wallet/sign-action', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const actionType = sanitizeText(req.body?.actionType || '', 64);
      const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }
      if (!_ALLOWED_SIGN_ACTIONS.has(actionType)) {
        return reply.code(400).send({ success: false, message: 'Unsupported actionType' });
      }

      const loaded = await _loadAndDecryptSeed(userId, pin);
      if (loaded.error) {
        const e = loaded.error;
        return reply.code(e.code).send(e.body || { success: false, message: e.message });
      }

      // Match the mobile app's L1 signing key derivation: SHA256(seed).
      // See migrate-to-secp comment above for why this is NOT mnemonicToEvm.
      const l1PrivKey0x = '0x' + seedToPrivateKey(loaded.seed);

      const secpAddr = evmPrivKeyToSecpAnetAddress(l1PrivKey0x);

      // Activation gate: refuse to sign a value-moving action (swap /
      // bridge burn) until the wallet has completed the 1000-session
      // activation. This protects users from losing funds — an un-
      // activated wallet has no spendable on-chain balance, so signing a
      // swap would either fail on chain or debit a later inbound bridge
      // credit. Once activated, the same swap (or a swap back) succeeds.
      const _VALUE_ACTIONS = new Set(['dex_swap', 'bridge_burn']);
      if (_VALUE_ACTIONS.has(actionType)) {
        const legacyAddr = evmPrivKeyToLegacyAnetAddress(l1PrivKey0x);

        // Unlock criterion must match the Send (transfer-intent) endpoint
        // exactly: completing 1000 mining sessions unlocks send, swap and
        // bridge alike. We honor the off-chain DB session count FIRST so a
        // user who has hit 1000 sessions is never blocked just because the
        // chain has not finished syncing their account yet. The on-chain
        // check is a fallback for wallets already activated on chain.
        let dbSessions = 0;
        try {
          const sRes = await db.query(
            `SELECT COALESCE(successful_sessions, 0) AS s
               FROM users WHERE id = $1 LIMIT 1`,
            [userId]
          );
          dbSessions = Number(sRes.rows[0]?.s || 0);
        } catch (_) { /* fall back to on-chain check below */ }

        let activated = dbSessions >= MIN_SESSIONS_FOR_ANET;
        let activation = {
          activated,
          web2Sessions: dbSessions,
          sessionsNeeded: Math.max(0, MIN_SESSIONS_FOR_ANET - dbSessions),
        };
        if (!activated) {
          const onchain = await _checkWalletActivation(secpAddr, legacyAddr);
          // Take the more favorable (higher) session count / activation.
          activation = {
            activated: onchain.activated,
            web2Sessions: Math.max(dbSessions, onchain.web2Sessions),
            sessionsNeeded: Math.min(activation.sessionsNeeded, onchain.sessionsNeeded),
          };
          activated = onchain.activated;
        }

        if (!activated) {
          await logAudit(db, {
            eventType: 'action_blocked_not_activated',
            userId, ip: req.ip,
            details: { actionType, secpAddr, legacyAddr, ...activation },
          });
          return reply.code(409).send({
            success: false,
            status: 'not_activated_yet',
            actionType,
            message:
              `Your wallet has ${activation.web2Sessions} mining session` +
              `${activation.web2Sessions === 1 ? '' : 's'} so far. ` +
              `You need ${activation.sessionsNeeded} more (total ${MIN_SESSIONS_FOR_ANET}) ` +
              `before your balance becomes spendable. Keep mining — once ` +
              `activated you can swap, swap back, or bridge freely and no ` +
              `funds are lost.`,
            current_sessions: activation.web2Sessions,
            sessions_needed: activation.sessionsNeeded,
            min_sessions_for_activation: MIN_SESSIONS_FOR_ANET,
            wallet_address: secpAddr,
            waitlist_available: true,
          });
        }
      }

      const auth = signAnetActionAuth({
        privKeyHex: l1PrivKey0x,
        wallet: secpAddr,
        actionType,
        chainId: ANET_CHAIN_ID,
        payload,
      });

      await logAudit(db, {
        eventType: 'action_signed_for_user',
        userId, ip: req.ip,
        details: { actionType, wallet: secpAddr },
      });

      return { success: true, wallet_address: secpAddr, auth };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to sign action' });
    }
  });

  /**
   * Restore a seed phrase from the client's on-device backup.
   *
   * Used when the server-side ciphertext is unreadable (key lost during
   * a deploy window, etc.). The client already verified the user owns
   * this device (JWT + PIN); we additionally require that the submitted
   * mnemonic derives to either the user's stored `wallet_address` or
   * `custom_wallet_address` — that is the cryptographic proof the seed
   * matches the existing wallet.
   *
   * Hard guarantees:
   *   - Will NOT overwrite a server seed that currently decrypts cleanly.
   *   - Will NOT change wallet_address.
   *   - Mnemonic must validate as BIP-39.
   */
  fastify.post('/wallet/seed/backup', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 4, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const seedPhrase = String(req.body?.seedPhrase || '').trim();

      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'seed_backup_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) return runtimeCheck.response;

      if (!isValidPin(pin)) {
        return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
      }
      if (!seedPhrase) {
        return reply.code(400).send({ success: false, message: 'Seed phrase is required' });
      }

      // Normalize and BIP-39 validate.
      const bip39lib = require('bip39');
      const normalized = seedPhrase.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!bip39lib.validateMnemonic(normalized)) {
        return reply.code(400).send({ success: false, message: 'Seed phrase failed BIP-39 validation' });
      }

      const userRes = await db.query(
        `SELECT id, pin_hash,
                wallet_address, custom_wallet_address,
                wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag, wallet_seed_key_version
         FROM users
         WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (!user.pin_hash) {
        return reply.code(400).send({ success: false, message: 'Set your PIN first' });
      }

      const validPin = await bcrypt.compare(pin, user.pin_hash);
      if (!validPin) {
        try { await logAudit(db, { eventType: 'pin_verify_failed', userId, ip: req.ip }); } catch (_) {}
        return reply.code(401).send({ success: false, message: 'Invalid PIN' });
      }

      // Refuse to overwrite a server seed that still decrypts cleanly —
      // that path is the user's existing recovery key and must not be
      // replaced from a client-supplied value.
      if (user.wallet_seed_encrypted && user.wallet_seed_iv && user.wallet_seed_tag) {
        try {
          decryptSecretEx(user.wallet_seed_encrypted, user.wallet_seed_iv, user.wallet_seed_tag, user.wallet_seed_key_version);
          return reply.code(409).send({
            success: false,
            message: 'Server already has a readable seed backup. Use Reveal instead.',
          });
        } catch (_) {
          // Decrypt failed with all known keys → safe to overwrite.
        }
      }

      // Cryptographic proof: the submitted mnemonic must derive to the
      // user's existing wallet address. This prevents an attacker who
      // grabbed a JWT+PIN from swapping in a wallet they control.
      const derived = generateCustomWalletAddress(normalized);
      const storedAnet = String(user.wallet_address || '').toUpperCase();
      const storedCustom = String(user.custom_wallet_address || '').toUpperCase();
      if (derived !== storedAnet && (!storedCustom || derived !== storedCustom)) {
        try {
          await logAudit(db, {
            eventType: 'seed_backup_address_mismatch',
            userId,
            ip: req.ip,
            details: { derived, storedAnet, storedCustom },
          });
        } catch (_) {}
        return reply.code(403).send({
          success: false,
          message: 'Seed phrase does not match this wallet address. Backup refused.',
        });
      }

      // All checks pass — encrypt with v2 + write PIN copy.
      const enc = encryptSecret(normalized);
      const pinEnc = encryptWithPin(normalized, pin, userId);
      await db.query(
        `UPDATE users
         SET wallet_seed_encrypted     = $1,
             wallet_seed_iv            = $2,
             wallet_seed_tag           = $3,
             wallet_seed_key_version   = 2,
             wallet_seed_pin_encrypted = $4,
             wallet_seed_pin_iv        = $5,
             wallet_seed_pin_tag       = $6,
             wallet_passphrase         = NULL,
             updated_at                = NOW()
         WHERE id = $7`,
        [enc.encrypted, enc.iv, enc.tag, pinEnc.encrypted, pinEnc.iv, pinEnc.tag, userId]
      );

      try {
        await logAudit(db, {
          eventType: 'seed_backup_restored',
          userId,
          ip: req.ip,
          details: { previousKeyVersion: user.wallet_seed_key_version },
        });
      } catch (_) {}

      return {
        success: true,
        message: 'Seed phrase backup restored. Your wallet is now protected by the server backup again.',
      };
    } catch (err) {
      console.error('[Auth] seed/backup error:', err);
      return reply.code(500).send({ success: false, message: 'Failed to back up seed' });
    }
  });

  /**
   * Consent-based wallet recovery for the "lost server seed" cohort.
   *
   * Context: a key-rotation incident left ~80k users whose server-side seed
   * ciphertext can no longer be decrypted with any known key. Those users'
   * seeds are unrecoverable on the server. The mobile client first tries to
   * self-heal from its on-device local backup (via /wallet/seed/backup). This
   * endpoint is the LAST RESORT for users who also have NO local seed on the
   * device — it provisions a fresh wallet (new seed + address) for the SAME
   * account/email, preserving custodial balance, sessions, referrals and all
   * other user-row data (those are keyed to the user id, not the wallet
   * address).
   *
   * Hard safety guards (this endpoint refuses to run otherwise):
   *   1. If the current server seed STILL decrypts, the wallet is healthy —
   *      we never overwrite a working recovery key. (Use Reveal instead.)
   *   2. If the wallet is on-chain ACTIVATED (total_sessions >= 1000), it may
   *      hold on-chain coins that a new address could not recover. We refuse
   *      and route the user to support / on-chain migration instead of
   *      silently orphaning funds. (Diagnostic shows 0 such users today, but
   *      this guard makes the endpoint safe permanently.)
   */
  fastify.post('/wallet/recover-new', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 3, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const acknowledged = req.body?.acknowledgeNewWallet === true;

      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'wallet_recover_blocked_insecure_runtime',
        userId,
      });
      if (runtimeCheck.blocked) return runtimeCheck.response;

      if (!acknowledged) {
        return reply.code(400).send({
          success: false,
          message: 'Recovery requires explicit confirmation (acknowledgeNewWallet=true).',
        });
      }

      const userRes = await db.query(
        `SELECT id, pin_hash, email_verified,
                wallet_address, custom_wallet_address,
                wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag, wallet_seed_key_version,
                ant_balance, ants_balance,
                COALESCE(total_sessions, 0) AS total_sessions
         FROM users
         WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE
         LIMIT 1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (!user.email_verified) {
        return reply.code(403).send({ success: false, message: 'Verify your email before recovering a wallet.' });
      }

      // When a PIN is set, require it. (Mirrors /wallet/seed/backup.)
      if (user.pin_hash) {
        if (!isValidPin(pin)) {
          return reply.code(400).send({ success: false, message: 'PIN must be 4 to 8 digits' });
        }
        const validPin = await bcrypt.compare(pin, user.pin_hash);
        if (!validPin) {
          try { await logAudit(db, { eventType: 'pin_verify_failed', userId, ip: req.ip }); } catch (_) {}
          return reply.code(401).send({ success: false, message: 'Invalid PIN' });
        }
      }

      // GUARD 1 — never overwrite a wallet whose server seed still decrypts.
      if (user.wallet_seed_encrypted && user.wallet_seed_iv && user.wallet_seed_tag) {
        try {
          decryptSecretEx(
            user.wallet_seed_encrypted,
            user.wallet_seed_iv,
            user.wallet_seed_tag,
            user.wallet_seed_key_version
          );
          return reply.code(409).send({
            success: false,
            code: 'wallet_healthy',
            message: 'Your wallet seed is still recoverable. Use Reveal instead of creating a new wallet.',
          });
        } catch (_) {
          // Decrypt failed with all known keys → genuinely lost → safe to recover.
        }
      }

      // GUARD 2 — never replace the address of an on-chain ACTIVATED wallet.
      if (Number(user.total_sessions || 0) >= 1000) {
        try {
          await logAudit(db, {
            eventType: 'wallet_recover_blocked_activated',
            userId,
            ip: req.ip,
            details: { totalSessions: Number(user.total_sessions || 0), oldAddress: user.wallet_address },
          });
        } catch (_) {}
        return reply.code(409).send({
          success: false,
          code: 'wallet_activated',
          message: 'This wallet may hold on-chain balance and cannot be auto-replaced. Please contact support for recovery.',
        });
      }

      const oldAddress = user.wallet_address || user.custom_wallet_address || null;

      // Provision a fresh wallet on the SAME user row. Custodial balance,
      // sessions, referrals etc. are keyed to user id and are untouched.
      let recovered = null;
      let newSeedPhrase = null;
      for (let i = 0; i < 5; i += 1) {
        const generated = createWallet();
        const address = generated.address;
        const passphrase = generated.seed;
        const enc = encryptSecret(passphrase);
        const pinEnc = user.pin_hash ? encryptWithPin(passphrase, pin, userId) : null;

        try {
          const updateRes = await db.query(
            `UPDATE users
             SET wallet_address              = $1,
                 custom_wallet_address       = $2,
                 wallet_seed_encrypted       = $3,
                 wallet_seed_iv              = $4,
                 wallet_seed_tag             = $5,
                 wallet_seed_key_version     = 2,
                 wallet_seed_pin_encrypted   = $6,
                 wallet_seed_pin_iv          = $7,
                 wallet_seed_pin_tag         = $8,
                 wallet_passphrase           = NULL,
                 seed_view_otp_hash          = NULL,
                 seed_view_otp_expiry        = NULL,
                 seed_view_otp_attempts      = 0,
                 updated_at                  = NOW()
             WHERE id = $9
             RETURNING wallet_address, custom_wallet_address, balance, ant_balance, ants_balance`,
            [
              address,
              address,
              enc.encrypted,
              enc.iv,
              enc.tag,
              pinEnc ? pinEnc.encrypted : null,
              pinEnc ? pinEnc.iv : null,
              pinEnc ? pinEnc.tag : null,
              userId,
            ]
          );
          if (updateRes.rows[0]) {
            recovered = updateRes.rows[0];
            newSeedPhrase = passphrase;
            break;
          }
        } catch (e) {
          // 23505 = unique violation on a freshly generated address collision;
          // retry with a new wallet. Anything else is fatal.
          if (e.code !== '23505') throw e;
        }
      }

      if (!recovered) {
        return reply.code(500).send({ success: false, message: 'Failed to provision recovery wallet. Please try again.' });
      }

      try {
        await logAudit(db, {
          eventType: 'wallet_recovered_new',
          userId,
          ip: req.ip,
          details: { oldAddress, newAddress: recovered.wallet_address },
        });
      } catch (_) {}

      const appBalanceAnts = Math.max(
        Number(recovered.ants_balance || 0),
        Number(recovered.ant_balance || 0)
      );

      return {
        success: true,
        message: 'A new secure wallet was created and linked to your account. Your balance and history are preserved. Write down your new recovery phrase now — it is shown only once.',
        oneTimeSeedPhrase: newSeedPhrase,
        wallet: {
          address: recovered.wallet_address,
          customAddress: recovered.custom_wallet_address,
          displayAddress: recovered.custom_wallet_address || recovered.wallet_address,
          appBalance: antsToAnet(appBalanceAnts),
          appBalanceAnts,
        },
      };
    } catch (err) {
      console.error('[Auth] wallet/recover-new error:', err);
      return reply.code(500).send({ success: false, message: 'Wallet recovery failed' });
    } finally {
      clearAuthReadCacheForUser(req.user.userId);
    }
  });

  fastify.post('/account/delete', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 6, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const pin = sanitizeText(req.body?.pin || '', 16);
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'account_delete_blocked_insecure_runtime',
        userId,
        responseType: 'message',
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      const userRes = await db.query(
        `SELECT id, pin_hash, is_deleted
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId]
      );
      const user = userRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }
      if (Boolean(user.is_deleted)) {
        return { success: true, message: 'Account deletion already requested' };
      }

      if (user.pin_hash) {
        const validPin = await bcrypt.compare(pin, user.pin_hash);
        if (!validPin) {
          return reply.code(401).send({ success: false, message: 'Invalid PIN' });
        }
      }

      await db.query(
        `UPDATE users
         SET is_deleted = TRUE,
             deletion_requested_at = NOW(),
             deletion_scheduled_for = NOW() + ($2 || ' days')::interval,
             is_mining = FALSE,
             updated_at = NOW()
         WHERE id = $1`,
        [userId, ACCOUNT_DELETE_DELAY_DAYS]
      );

      await logAudit(db, {
        eventType: 'account_soft_deleted',
        userId,
        ip: req.ip,
        details: { deletionDelayDays: ACCOUNT_DELETE_DELAY_DAYS },
      });

      return {
        success: true,
        message: `Account scheduled for deletion in ${ACCOUNT_DELETE_DELAY_DAYS} days`,
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to schedule account deletion' });
    }
  });

  fastify.post('/change-email', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const { newEmail, password, otp } = req.body || {};
      const normalizedEmail = String(newEmail || '').trim().toLowerCase();
      const submittedOtp = String(otp || '').trim();
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'change_email_blocked_insecure_runtime',
        userId,
        email: normalizedEmail || null,
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!normalizedEmail || !password) {
        return reply.code(400).send({ error: 'newEmail and password are required' });
      }

      if (!isValidEmail(normalizedEmail)) {
        return reply.code(400).send({ error: 'Invalid email format' });
      }

      const me = await db.query(
        `SELECT id, email, password FROM users WHERE id = $1`,
        [userId]
      );

      if (!me.rows[0]) {
        return reply.code(404).send({ error: 'User not found' });
      }
      const currentEmail = String(me.rows[0].email || '').trim().toLowerCase();

      const valid = await bcrypt.compare(password, me.rows[0].password);
      if (!valid) {
        try { await logAudit(db, { eventType: 'change_email_invalid_password', userId, ip: req.ip }); } catch (_) {}
        return reply.code(401).send({ error: 'Current password is invalid' });
      }

      if (normalizedEmail === currentEmail) {
        return reply.code(400).send({ error: 'New email is the same as your current email' });
      }

      // Surface a clear warning if the address is already known to the
      // platform — either an active user, a soft-deleted user, or an
      // on-chain wallet record. We never reveal which one for privacy,
      // just refuse with one consistent message.
      const conflict = await db.query(
        `SELECT id, COALESCE(is_deleted, FALSE) AS is_deleted, wallet_address
         FROM users
         WHERE email = $1 AND id != $2
         LIMIT 1`,
        [normalizedEmail, userId]
      );
      if (conflict.rows.length > 0) {
        const row = conflict.rows[0];
        try {
          await logAudit(db, {
            eventType: 'change_email_target_already_registered',
            userId,
            ip: req.ip,
            details: {
              attempted: normalizedEmail,
              conflictIsDeleted: row.is_deleted,
              conflictHasWallet: !!row.wallet_address,
            },
          });
        } catch (_) {}
        return reply.code(409).send({
          error: 'email_already_registered',
          message:
            'This email is already registered in the A-Network system and is linked to an ANET wallet on-chain. Please use a different email.',
        });
      }

      // Step 1: no OTP provided -> issue a one-time code to the CURRENT
      // (old) email so the legitimate account owner has to approve the
      // change. Without this, a stolen JWT + leaked password would be
      // enough for an attacker to silently relocate the account.
      if (!submittedOtp) {
        if (!currentEmail) {
          return reply.code(400).send({ error: 'Account has no email on file to verify change request' });
        }
        const otpResult = await createAndSendOtp(currentEmail, userId, 'change_email');
        if (otpResult.cooldown) {
          return reply.code(429).send({
            otpRequired: true,
            otpSent: false,
            cooldown: true,
            waitSeconds: otpResult.waitSeconds,
            message: `Please wait ${otpResult.waitMins} minute(s) before requesting another code.`,
          });
        }
        try {
          await logAudit(db, {
            eventType: 'change_email_otp_sent',
            userId,
            ip: req.ip,
            details: { from: currentEmail, to: normalizedEmail },
          });
        } catch (_) {}
        return {
          otpRequired: true,
          otpSent: otpResult.sendResult?.sent !== false,
          message: 'A verification code has been sent to your current email. Submit it with this request to confirm the change.',
        };
      }

      // Step 2: verify OTP against the CURRENT email + change_email purpose.
      const matched = await findMatchingOtpRecord(currentEmail, 'change_email', submittedOtp, userId);
      if (!matched) {
        try { await logAudit(db, { eventType: 'change_email_otp_invalid', userId, ip: req.ip }); } catch (_) {}
        return reply.code(401).send({ otpRequired: true, error: 'Invalid or expired verification code' });
      }
      await markOtpRecordsUsed(currentEmail, 'change_email', userId);

      // Important: the new address has NOT been verified yet. Set
      // email_verified = FALSE so the next login forces an OTP to the
      // new mailbox, proving the user controls it. Do NOT silently mark
      // it verified — that was the original vulnerability.
      const updated = await db.query(
        `UPDATE users
         SET email = $1,
             email_verified = FALSE,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, email, email_verified`,
        [normalizedEmail, userId]
      );

      try {
        await logAudit(db, {
          eventType: 'change_email_completed',
          userId,
          ip: req.ip,
          details: { from: currentEmail, to: normalizedEmail },
        });
      } catch (_) {}

      // Best-effort notification to the OLD address that the change
      // happened, so a real user who didn't initiate it can react.
      try {
        const subject = 'Your A-Network email address was changed';
        const bodyLines = [
          `The email on your A-Network account was just changed to <strong>${normalizedEmail}</strong>.`,
          'If you did not request this, contact support immediately and reset your password — your account may have been compromised.',
        ];
        const html = buildOtpEmailHtml({
          title: 'Email Address Changed',
          bodyLines,
          otp: '',
          previewText: 'Your A-Network email was changed',
        });
        const text = `Your A-Network email was changed to ${normalizedEmail}. If this was not you, contact support immediately.`;
        await sendEmail(currentEmail, subject, html, text);
      } catch (notifyErr) {
        console.warn('[change-email] notify old address failed:', notifyErr?.message || notifyErr);
      }

      return {
        message: 'Email updated. Please verify the new address at your next login.',
        user: updated.rows[0],
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to update email' });
    }
  });

  fastify.post('/change-password', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body || {};
      const runtimeCheck = await enforceSecureRuntime(req, reply, {
        eventType: 'change_password_blocked_insecure_runtime',
        userId,
      });
      if (runtimeCheck.blocked) {
        return runtimeCheck.response;
      }

      if (!currentPassword || !newPassword) {
        return reply.code(400).send({ error: 'currentPassword and newPassword are required' });
      }

      if (newPassword.length < 8) {
        return reply.code(400).send({ error: 'New password must be at least 8 characters' });
      }

      const me = await db.query(
        `SELECT id, password FROM users WHERE id = $1`,
        [userId]
      );

      if (!me.rows[0]) {
        return reply.code(404).send({ error: 'User not found' });
      }

      const valid = await bcrypt.compare(currentPassword, me.rows[0].password);
      if (!valid) {
        return reply.code(401).send({ error: 'Current password is invalid' });
      }

      const hashed = await bcrypt.hash(newPassword, 10);
      await db.query(
        `UPDATE users SET password = $1 WHERE id = $2`,
        [hashed, userId]
      );

      return { message: 'Password updated successfully' };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: 'Failed to update password' });
    }
  });
};