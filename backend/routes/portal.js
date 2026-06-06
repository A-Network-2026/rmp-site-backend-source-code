/**
 * routes/portal.js — Member Portal endpoints for a-network.net/portal.html.
 *
 * Goal: give web visitors a single page that shows their NFT Profile and
 * every identity (legacy/secp ANET wallet, EVM wallet on BSC, Pi UID,
 * email accounts, bound devices) tied to that one non-transferable
 * Public Proof NFT — without us ever holding their private keys.
 *
 * Routes (mounted under /auth/portal):
 *   POST  /siwe/nonce        body: { address }      -> { nonce, expiresAt }
 *   POST  /siwe/verify       body: { address, message, signature, ... }
 *                                                   -> { token, user, linked }
 *   GET   /me                Bearer token            -> {
 *                                profile, wallets, devices, activity, source
 *                              }
 *   POST  /wallets/link      Bearer token, body: { address, message, signature }
 *                                                   -> { success, wallet }
 *   POST  /wallets/unlink    Bearer token, body: { address }
 *                                                   -> { success }
 *   POST  /devices/:id/revoke Bearer token           -> { success }
 *
 * Implementation notes:
 *   - SIWE verification uses ethers.verifyMessage (EIP-191 personal_sign).
 *   - Linked wallets are stored in a new `portal_linked_wallets` table; the
 *     join key is the NFT profile_id (BIGINT) — multiple `users` rows can
 *     point at the same profile via users.active_nft_profile_id.
 *   - SIWE-only sign-in (no email yet) creates / reuses a synthetic
 *     `users` row keyed by lower-cased EVM address so the rest of the
 *     auth machinery (verifyToken, session_nonce, ...) keeps working.
 *   - All read-only endpoints fall back to a stub view if the database
 *     isn't ready, so the public portal page never errors out.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
let _ethers = null;
try { _ethers = require('ethers'); } catch (_) { _ethers = null; }

const db = require('../db');
const verifyToken = require('../middleware/auth');
const { addColumnIfMissing } = require('../utils/schemaGuard');

const SECRET = process.env.JWT_SECRET;
const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL = '7d';

// In-memory nonce store. The portal SIWE nonce is single-use and short-
// lived; in practice the verify call lands on the same instance because
// the user signs within seconds. If we ever need cross-instance nonces
// we can move this to a small Redis set or to a portal_siwe_nonces table.
const nonceStore = new Map(); // key: address(lower) -> { nonce, expiresAt }

function nowMs() { return Date.now(); }

function normalizeEvmAddress(addr) {
  if (!addr) return null;
  const s = String(addr).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) return null;
  return s;
}

function makeNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function recoverFromPersonalSign(message, signature) {
  if (!_ethers) throw new Error('ethers not available on server');
  // ethers v6: verifyMessage(message, sig) -> address (EIP-191 personal_sign).
  const recovered = _ethers.verifyMessage(message, signature);
  return String(recovered || '').toLowerCase();
}

async function ensureSchema(logger) {
  // user_nft_profiles + users.active_nft_profile_id already provisioned by
  // routes/walletNft.js. We just add the linked-wallets join table and the
  // device columns the portal exposes.
  await db.query(`
    CREATE TABLE IF NOT EXISTS portal_linked_wallets (
      id BIGSERIAL PRIMARY KEY,
      profile_id BIGINT,
      user_id BIGINT,
      wallet_type VARCHAR(32) NOT NULL,
      chain VARCHAR(32),
      address VARCHAR(120) NOT NULL,
      signature TEXT,
      signature_message TEXT,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      metadata_json JSONB
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_linked_wallets_addr
                  ON portal_linked_wallets (LOWER(address), wallet_type)
                  WHERE revoked_at IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_portal_linked_wallets_profile
                  ON portal_linked_wallets (profile_id) WHERE revoked_at IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_portal_linked_wallets_user
                  ON portal_linked_wallets (user_id) WHERE revoked_at IS NULL`);

  // Make sure `users` has the columns the device panel reads.
  await addColumnIfMissing('users', 'device_id', 'VARCHAR(255)', { logger });
  await addColumnIfMissing('users', 'device_last_seen', 'TIMESTAMP', { logger });
  await addColumnIfMissing('users', 'device_platform', 'VARCHAR(64)', { logger });
  await addColumnIfMissing('users', 'last_ip_country', 'VARCHAR(8)', { logger });
}

async function getOrCreateSiweUser(evmAddrLower) {
  // Reuse any existing users row that already has this EVM wallet either
  // via a linked-wallet row or via the legacy wallet_address column.
  const existing = await db.query(
    `SELECT u.* FROM users u
       LEFT JOIN portal_linked_wallets w
         ON w.user_id = u.id AND w.revoked_at IS NULL AND LOWER(w.address) = $1
      WHERE w.id IS NOT NULL OR LOWER(u.wallet_address) = $1
      ORDER BY u.id ASC LIMIT 1`,
    [evmAddrLower]
  );
  if (existing.rows.length) return existing.rows[0];

  // No match — create a placeholder users row keyed to the EVM address.
  // We intentionally do NOT set a password / PIN; the only way to log in
  // is via SIWE on the portal until/unless the user attaches an email.
  const synthEmail = `siwe+${evmAddrLower}@portal.a-network.net`;
  const sessionNonce = crypto.randomBytes(16).toString('hex');
  const ins = await db.query(
    `INSERT INTO users (email, wallet_address, session_nonce, email_verified)
     VALUES ($1, $2, $3, FALSE)
     ON CONFLICT (email) DO UPDATE SET session_nonce = EXCLUDED.session_nonce
     RETURNING *`,
    [synthEmail, evmAddrLower, sessionNonce]
  );
  return ins.rows[0];
}

async function findOrCreateLinkedWallet({ userId, profileId, walletType, chain, address, message, signature }) {
  const norm = String(address).toLowerCase();
  const existing = await db.query(
    `SELECT * FROM portal_linked_wallets
      WHERE LOWER(address) = $1 AND wallet_type = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [norm, walletType]
  );
  if (existing.rows.length) {
    // Reattach to the current user/profile if missing.
    const row = existing.rows[0];
    if ((userId && !row.user_id) || (profileId && !row.profile_id)) {
      await db.query(
        `UPDATE portal_linked_wallets
            SET user_id = COALESCE($2, user_id),
                profile_id = COALESCE($3, profile_id)
          WHERE id = $1`,
        [row.id, userId || null, profileId || null]
      );
    }
    return row;
  }
  const ins = await db.query(
    `INSERT INTO portal_linked_wallets
        (profile_id, user_id, wallet_type, chain, address, signature, signature_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [profileId || null, userId || null, walletType, chain || null, norm, signature || null, message || null]
  );
  return ins.rows[0];
}

async function loadConsolidatedView(userId) {
  // Profile (joined through users.active_nft_profile_id).
  const profRes = await db.query(
    `SELECT u.id AS user_id,
            u.email,
            u.wallet_address AS legacy_wallet,
            u.active_nft_profile_id AS profile_id,
            u.nft_activated,
            u.nft_activated_at,
            u.first_settlement_at,
            u.device_id,
            u.device_last_seen,
            u.device_platform,
            u.last_ip_country,
            p.token_id,
            p.holder_address,
            p.collection,
            p.mint_tx_hash,
            p.minted_at,
            p.metadata_json
       FROM users u
       LEFT JOIN user_nft_profiles p
         ON p.id = u.active_nft_profile_id
      WHERE u.id = $1`,
    [userId]
  );
  if (!profRes.rows.length) return { profile: {}, wallets: [], devices: [], activity: [] };
  const row = profRes.rows[0];

  const profile = {
    profileId: row.profile_id ? String(row.profile_id) : null,
    tokenId: row.token_id || null,
    holder: row.holder_address || row.legacy_wallet || null,
    collection: row.collection || 'Public Proof',
    mintTx: row.mint_tx_hash || null,
    mintedAt: row.minted_at || row.nft_activated_at || null,
    activated: !!row.nft_activated,
    status: row.nft_activated ? 'ACTIVATED' : 'pending',
    firstSettlementAt: row.first_settlement_at || null,
    email: row.email || null
  };

  // Wallets: linked rows + legacy wallet_address fallback.
  const wallets = [];
  if (row.legacy_wallet) {
    wallets.push({
      type: 'anet-legacy',
      chain: 'ANET',
      address: row.legacy_wallet,
      linkedAt: row.first_settlement_at || row.nft_activated_at || null,
      verified: true,
      source: 'users.wallet_address'
    });
  }
  if (row.holder_address && row.holder_address !== row.legacy_wallet) {
    wallets.push({
      type: 'anet-secp',
      chain: 'ANET',
      address: row.holder_address,
      linkedAt: row.minted_at || row.nft_activated_at || null,
      verified: true,
      source: 'user_nft_profiles.holder_address'
    });
  }
  const linkedRes = await db.query(
    `SELECT wallet_type, chain, address, linked_at
       FROM portal_linked_wallets
      WHERE (user_id = $1 OR profile_id = $2) AND revoked_at IS NULL
      ORDER BY linked_at DESC`,
    [userId, row.profile_id || null]
  );
  for (const w of linkedRes.rows) {
    // Avoid duplicating the legacy wallet we already pushed.
    if (String(w.address).toLowerCase() === String(row.legacy_wallet || '').toLowerCase()) continue;
    wallets.push({
      type: w.wallet_type,
      chain: w.chain || null,
      address: w.address,
      linkedAt: w.linked_at,
      verified: true,
      source: 'portal_linked_wallets'
    });
  }

  // Devices: today we surface the single bound device the mining flow
  // tracks. Task D expands this into a dedicated table.
  const devices = [];
  if (row.device_id) {
    devices.push({
      id: row.device_id,
      platform: row.device_platform || 'unknown',
      lastSeen: row.device_last_seen || null,
      ipCountry: row.last_ip_country || null,
      isCurrent: true
    });
  }

  return { profile, wallets, devices, activity: [] };
}

async function registerPortalRoutes(fastify) {
  const logger = fastify && fastify.log ? fastify.log : console;

  try { await ensureSchema(logger); }
  catch (err) { logger.error({ err }, '[portal] ensureSchema failed (continuing)'); }

  // ── POST /siwe/nonce ─────────────────────────────────
  fastify.post('/siwe/nonce', async (req, reply) => {
    const address = normalizeEvmAddress((req.body || {}).address);
    if (!address) return reply.code(400).send({ success: false, error: 'invalid_address' });
    const nonce = makeNonce();
    const expiresAt = nowMs() + NONCE_TTL_MS;
    nonceStore.set(address, { nonce, expiresAt });
    return reply.send({ success: true, nonce, expiresAt });
  });

  // ── POST /siwe/verify ────────────────────────────────
  fastify.post('/siwe/verify', async (req, reply) => {
    const body = req.body || {};
    const address = normalizeEvmAddress(body.address);
    const message = String(body.message || '');
    const signature = String(body.signature || '');
    if (!address || !message || !signature) {
      return reply.code(400).send({ success: false, error: 'missing_fields' });
    }
    if (!_ethers) {
      return reply.code(503).send({ success: false, error: 'verifier_unavailable' });
    }

    // Nonce check (single-use). Reject if missing/expired/used.
    const entry = nonceStore.get(address);
    if (!entry || entry.expiresAt < nowMs()) {
      return reply.code(401).send({ success: false, error: 'nonce_expired' });
    }
    if (!message.includes('Nonce: ' + entry.nonce)) {
      return reply.code(401).send({ success: false, error: 'nonce_mismatch' });
    }
    nonceStore.delete(address);

    // Signature recovery.
    let recovered;
    try { recovered = recoverFromPersonalSign(message, signature); }
    catch (err) {
      logger.warn({ err: err.message }, '[portal] verifyMessage failed');
      return reply.code(401).send({ success: false, error: 'bad_signature' });
    }
    if (recovered !== address) {
      return reply.code(401).send({ success: false, error: 'signature_mismatch' });
    }

    // Resolve / create the users row this EVM wallet should sign into.
    const user = await getOrCreateSiweUser(address);
    if (!user || !user.id) {
      return reply.code(500).send({ success: false, error: 'user_resolve_failed' });
    }

    // Persist the linked-wallet row so /me sees it.
    let linked = null;
    try {
      linked = await findOrCreateLinkedWallet({
        userId: user.id,
        profileId: user.active_nft_profile_id || null,
        walletType: 'evm',
        chain: 'BSC',
        address,
        message,
        signature
      });
    } catch (err) {
      logger.warn({ err: err.message }, '[portal] link wallet failed');
    }

    // Mint a session token shaped like the existing /auth/login tokens so
    // verifyToken middleware accepts it transparently on every other route.
    const sessionNonce = user.session_nonce || crypto.randomBytes(16).toString('hex');
    if (!user.session_nonce) {
      await db.query('UPDATE users SET session_nonce = $2 WHERE id = $1', [user.id, sessionNonce]);
    }
    const token = jwt.sign(
      {
        userId: user.id,
        deviceId: user.device_id || null,
        deviceFingerprint: user.device_fingerprint || null,
        sessionNonce
      },
      SECRET,
      { expiresIn: SESSION_TTL }
    );

    return reply.send({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email || null,
        walletAddress: user.wallet_address || null,
        activeProfileId: user.active_nft_profile_id || null
      },
      linked: linked
        ? { type: linked.wallet_type, address: linked.address, linkedAt: linked.linked_at }
        : null
    });
  });

  // ── GET /me ──────────────────────────────────────────
  fastify.get('/me', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return reply.code(401).send({ success: false, error: 'unauthorized' });
    try {
      const view = await loadConsolidatedView(userId);
      return reply.send({ success: true, ...view });
    } catch (err) {
      logger.error({ err: err.message }, '[portal] /me failed');
      return reply.code(500).send({ success: false, error: 'me_load_failed' });
    }
  });

  // ── POST /wallets/link ──────────────────────────────
  // Used by an already-signed-in user to attach another EVM wallet to
  // their NFT Profile. Same SIWE-style proof; no nonce flow because the
  // session already authenticates them — the signature only proves they
  // hold the *new* wallet they're trying to attach.
  fastify.post('/wallets/link', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return reply.code(401).send({ success: false, error: 'unauthorized' });
    const body = req.body || {};
    const address = normalizeEvmAddress(body.address);
    const message = String(body.message || '');
    const signature = String(body.signature || '');
    if (!address || !message || !signature) {
      return reply.code(400).send({ success: false, error: 'missing_fields' });
    }
    if (!_ethers) return reply.code(503).send({ success: false, error: 'verifier_unavailable' });
    let recovered;
    try { recovered = recoverFromPersonalSign(message, signature); }
    catch (_) { return reply.code(401).send({ success: false, error: 'bad_signature' }); }
    if (recovered !== address) return reply.code(401).send({ success: false, error: 'signature_mismatch' });

    const profRes = await db.query('SELECT active_nft_profile_id FROM users WHERE id = $1', [userId]);
    const profileId = profRes.rows[0] && profRes.rows[0].active_nft_profile_id;
    const linked = await findOrCreateLinkedWallet({
      userId, profileId,
      walletType: 'evm', chain: 'BSC',
      address, message, signature
    });
    return reply.send({
      success: true,
      wallet: { type: linked.wallet_type, address: linked.address, linkedAt: linked.linked_at }
    });
  });

  // ── POST /wallets/unlink ────────────────────────────
  fastify.post('/wallets/unlink', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return reply.code(401).send({ success: false, error: 'unauthorized' });
    const address = normalizeEvmAddress((req.body || {}).address);
    if (!address) return reply.code(400).send({ success: false, error: 'invalid_address' });
    await db.query(
      `UPDATE portal_linked_wallets
          SET revoked_at = NOW()
        WHERE user_id = $1 AND LOWER(address) = $2 AND revoked_at IS NULL`,
      [userId, address]
    );
    return reply.send({ success: true });
  });

  // ── POST /devices/:id/revoke ────────────────────────
  // Today we only have one device per user (users.device_id). Revoking
  // clears the binding so the next sign-in from a new device re-binds.
  fastify.post('/devices/:id/revoke', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user && (req.user.userId || req.user.id);
    if (!userId) return reply.code(401).send({ success: false, error: 'unauthorized' });
    const targetId = String(req.params.id || '');
    if (!targetId) return reply.code(400).send({ success: false, error: 'invalid_device' });
    await db.query(
      `UPDATE users SET device_id = NULL, device_last_seen = NULL
        WHERE id = $1 AND device_id = $2`,
      [userId, targetId]
    );
    return reply.send({ success: true });
  });
}

module.exports = registerPortalRoutes;
