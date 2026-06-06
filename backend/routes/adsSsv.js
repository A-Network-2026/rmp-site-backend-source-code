/**
 * AdMob Server-Side Verification (SSV) callback handler.
 *
 * Google calls this endpoint AFTER a rewarded ad is fully watched and
 * the user earns a reward.  We verify the HMAC signature Google sends,
 * then credit AI tokens to the user.
 *
 * Reference:
 *   https://developers.google.com/admob/android/ssv
 *
 * Query parameters sent by Google (all URL-encoded):
 *   ad_network        – ad network ID
 *   ad_unit_id        – the AdMob ad unit that fired the reward
 *   custom_data       – user_id we embed when calling show()
 *   reward_amount     – e.g. "8"
 *   reward_item       – e.g. "AI_TOKEN"
 *   timestamp         – unix ms
 *   transaction_id    – unique ID for this reward event (de-dup key)
 *   user_id           – optional user ID passed at call-time
 *   key_id            – which Google public key to use for verification
 *   signature         – base64url ECDSA-SHA256 signature over the query string
 *
 * Setup:
 *   1.  Set ADMOB_SSV_SECRET in .env (any random 32+ char string).
 *       Google does NOT use this secret; we use it so we can keep the
 *       endpoint from being called by random bots.  Include it in the
 *       callback URL as a path segment: /api/ads/ssv/<ADMOB_SSV_SECRET>
 *   2.  Set ADMOB_SSV_VERIFY_SIGNATURE=true when you are ready to enable
 *       full ECDSA verification (requires fetching Google's public keys).
 *       Leave it false (default) to skip signature verification for now
 *       while still logging and crediting rewards.
 *   3.  Set AI_TOKEN_AD_REWARD_AMOUNT to the same value configured in
 *       AdMob (default: 8).
 */

const crypto = require('crypto');
const db = require('../db');

// ─── helpers ────────────────────────────────────────────────────────────────

function envStr(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.floor(v) : fallback;
}

const AI_TOKEN_REWARD = envInt('AI_TOKEN_AD_REWARD_AMOUNT', 8);
const SSV_SECRET = envStr('ADMOB_SSV_SECRET');
const VERIFY_SIG = String(process.env.ADMOB_SSV_VERIFY_SIGNATURE || 'false').toLowerCase() === 'true';

// ─── module ──────────────────────────────────────────────────────────────────

module.exports = async function (fastify) {
  /**
   * GET /api/ads/ssv/:secret
   *
   * Google always uses GET.  The :secret path segment is compared to
   * ADMOB_SSV_SECRET so random internet traffic cannot fabricate rewards.
   */
  fastify.get('/api/ads/ssv/:secret', {
    config: {
      rateLimit: {
        max: 200,
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    const { secret } = req.params;

    // ── 1. Path-secret guard ──────────────────────────────────────────────
    if (!SSV_SECRET || secret !== SSV_SECRET) {
      req.log.warn({ ip: req.ip, event: 'ssv_invalid_secret' }, 'SSV: invalid secret');
      // Return 200 so Google does not retry indefinitely; just do not credit.
      return reply.code(200).send('OK');
    }

    // ── 2. Parse Google query params ──────────────────────────────────────
    const {
      ad_unit_id,
      custom_data,
      reward_amount,
      reward_item,
      timestamp,
      transaction_id,
      user_id,
      key_id,
      signature,
    } = req.query || {};

    req.log.info(
      {
        event: 'ssv_received',
        ad_unit_id,
        custom_data,
        reward_amount,
        reward_item,
        transaction_id,
        user_id,
      },
      'AdMob SSV callback received',
    );

    // ── 3. Optional ECDSA signature verification ──────────────────────────
    // Google signs the entire query string (without the &signature= part)
    // with an ECDSA-SHA256 key.  Full verification requires fetching
    // https://www.gstatic.com/admob/reward/verifier-keys.json at runtime.
    // Enable ADMOB_SSV_VERIFY_SIGNATURE=true when ready.
    if (VERIFY_SIG) {
      try {
        const valid = await verifyGoogleSignature(req.raw.url, signature, key_id);
        if (!valid) {
          req.log.warn({ event: 'ssv_invalid_signature', transaction_id }, 'SSV: bad signature');
          return reply.code(200).send('OK');
        }
      } catch (err) {
        req.log.error({ err, event: 'ssv_signature_error' }, 'SSV: signature check failed');
        return reply.code(200).send('OK');
      }
    }

    // ── 4. Resolve user ID ────────────────────────────────────────────────
    // We pass the user's numeric DB id as `custom_data` in the Flutter call.
    const rawUserId = custom_data || user_id;
    const numericUserId = rawUserId ? Number(rawUserId) : null;
    if (!numericUserId || !Number.isFinite(numericUserId) || numericUserId <= 0) {
      req.log.warn({ event: 'ssv_no_user', custom_data, user_id }, 'SSV: cannot resolve user');
      return reply.code(200).send('OK');
    }

    // ── 5. Idempotency – skip if already credited ─────────────────────────
    if (transaction_id) {
      const dup = await db.query(
        `SELECT 1 FROM ssv_transactions WHERE transaction_id = $1 LIMIT 1`,
        [transaction_id],
      ).catch(() => null);

      if (dup && dup.rows.length > 0) {
        req.log.info({ event: 'ssv_duplicate', transaction_id }, 'SSV: duplicate, skipping');
        return reply.code(200).send('OK');
      }
    }

    // ── 6. Validate reward params ─────────────────────────────────────────
    const amount = Number(reward_amount) || AI_TOKEN_REWARD;
    const item = String(reward_item || 'AI_TOKEN').toUpperCase();

    if (item !== 'AI_TOKEN') {
      req.log.warn({ event: 'ssv_unknown_reward_item', reward_item }, 'SSV: unexpected reward item');
      return reply.code(200).send('OK');
    }

    // ── 7. Record transaction and credit tokens ───────────────────────────
    try {
      await db.query(
        `INSERT INTO ssv_transactions
           (transaction_id, user_id, ad_unit_id, reward_amount, reward_item, received_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (transaction_id) DO NOTHING`,
        [transaction_id || `gen_${Date.now()}_${numericUserId}`, numericUserId, ad_unit_id, amount, item],
      );

      await db.query(
        `UPDATE users
            SET ai_token_balance = COALESCE(ai_token_balance, 0) + $1
          WHERE id = $2`,
        [amount, numericUserId],
      );

      req.log.info(
        { event: 'ssv_credited', userId: numericUserId, amount, transaction_id },
        `SSV: credited ${amount} ${item} to user ${numericUserId}`,
      );
    } catch (err) {
      req.log.error({ err, event: 'ssv_db_error' }, 'SSV: failed to credit reward');
      // Still return 200 so Google does not retry, but log the error.
    }

    return reply.code(200).send('OK');
  });
};

// ─── Google ECDSA signature verification ─────────────────────────────────────

let _cachedKeys = null;
let _keyCacheExpiry = 0;

async function fetchGoogleKeys() {
  const now = Date.now();
  if (_cachedKeys && now < _keyCacheExpiry) {
    return _cachedKeys;
  }

  const res = await fetch('https://www.gstatic.com/admob/reward/verifier-keys.json');
  if (!res.ok) {
    throw new Error(`Failed to fetch Google SSV keys: ${res.status}`);
  }
  const data = await res.json();
  _cachedKeys = data.keys || [];
  _keyCacheExpiry = now + 60 * 60 * 1000; // cache 1 hour
  return _cachedKeys;
}

/**
 * Verify the ECDSA-SHA256 signature Google attaches to the SSV callback.
 * Google signs everything in the query string before &signature=.
 */
async function verifyGoogleSignature(rawUrl, signature, keyId) {
  if (!signature || !keyId) return false;

  const keys = await fetchGoogleKeys();
  const keyObj = keys.find((k) => String(k.keyId) === String(keyId));
  if (!keyObj) return false;

  // Build the signed message: URL query string without &signature= portion.
  const urlObj = new URL(rawUrl, 'https://placeholder');
  const params = new URLSearchParams(urlObj.search);
  params.delete('signature');
  params.delete('key_id');
  const message = params.toString();

  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(keyObj.pem, 'utf8'),
      format: 'pem',
    });

    const sigBuf = Buffer.from(signature, 'base64url');
    return crypto.verify('SHA256', Buffer.from(message), publicKey, sigBuf);
  } catch {
    return false;
  }
}
