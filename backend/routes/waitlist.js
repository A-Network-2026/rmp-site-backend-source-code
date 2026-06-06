// routes/waitlist.js
//
// Soft swap waitlist (Phase 1 of the activation-waitlist design).
//
// Users whose L1 wallet is not yet activated (< 1000 sessions) and users
// whose bridge credit is still pending can record a swap intent that the
// backend will automatically attempt to execute as soon as the wallet
// becomes activated. Phase 1 is intentionally off-chain so we ship fast
// and gather UX data; Phase 2 will add BNB-fee cancellation and (later)
// an on-chain Merkle anchor for auditability.
//
// Endpoints (mounted at /waitlist by server.js):
//   POST   /create       { intentType, fromToken, toToken, fromAmount,
//                          toMinAmount, expiresInDays? }
//   GET    /mine                                  → list this user's intents
//   GET    /:id                                   → fetch a single intent
//   DELETE /:id                                   → cancel (Phase 1: free;
//                                                   Phase 2: requires BNB fee)
//   POST   /process-for-me                         → re-attempt any pending
//                                                   intents for this user
//                                                   (also fires automatically
//                                                   from migrate-to-secp on
//                                                   first successful reveal)
//
// All endpoints require a valid JWT.
'use strict';

const db = require('../db');
const verifyToken = require('../middleware/auth');

const MAX_INTENTS_PER_USER = 5;
const DEFAULT_EXPIRES_DAYS = 30;
const MAX_EXPIRES_DAYS = 90;

const ALLOWED_INTENT_TYPES = new Set(['swap', 'wrap', 'unwrap', 'bridge_out']);
const ALLOWED_TOKENS = new Set(['ANET', 'WANET', 'USDC', 'USDT', 'BNB']);

const FEE_WALLET_BNB = String(process.env.DEX_FEE_WALLET_BNB || '').trim();
const CANCEL_FEE_BNB = String(process.env.DEX_CANCEL_FEE_BNB || '0.001').trim();
const FEE_WALLET_READY = /^0x[0-9a-fA-F]{40}$/.test(FEE_WALLET_BNB);

let _schemaEnsured = false;

async function ensureSchema() {
  if (_schemaEnsured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS swap_waitlist (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT NOT NULL,
      wallet_address  VARCHAR(120) NOT NULL,
      intent_type     VARCHAR(24) NOT NULL,
      from_token      VARCHAR(16) NOT NULL,
      to_token        VARCHAR(16) NOT NULL,
      from_amount     NUMERIC(40,0) NOT NULL,
      to_min_amount   NUMERIC(40,0) NOT NULL DEFAULT 0,
      status          VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ NOT NULL,
      executed_at     TIMESTAMPTZ,
      executed_tx     VARCHAR(120),
      cancelled_at    TIMESTAMPTZ,
      cancel_reason   TEXT,
      cancel_fee_tx   VARCHAR(120),
      last_error      TEXT,
      attempt_count   INT NOT NULL DEFAULT 0
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS swap_waitlist_user_idx
      ON swap_waitlist (user_id, status)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS swap_waitlist_wallet_pending_idx
      ON swap_waitlist (wallet_address)
     WHERE status = 'pending'
  `);
  _schemaEnsured = true;
}

function normalizeToken(t) {
  return String(t || '').trim().toUpperCase();
}

function parseAmount(raw, fieldName) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) {
    const err = new Error(`${fieldName} must be a positive integer (smallest units)`);
    err.statusCode = 400;
    throw err;
  }
  if (s.length > 38) {
    const err = new Error(`${fieldName} exceeds maximum precision`);
    err.statusCode = 400;
    throw err;
  }
  return s;
}

function rowToView(row) {
  return {
    id: Number(row.id),
    walletAddress: row.wallet_address,
    intentType: row.intent_type,
    fromToken: row.from_token,
    toToken: row.to_token,
    fromAmount: row.from_amount,
    toMinAmount: row.to_min_amount,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    executedTx: row.executed_tx,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    cancelFeeTx: row.cancel_fee_tx,
    lastError: row.last_error,
    attemptCount: Number(row.attempt_count || 0),
  };
}

// Hook called by other routes after a wallet just got activated (e.g. the
// first successful migrate-to-secp reveal, or a bridge credit landing).
// Returns a small summary. Errors per-intent are caught and recorded on
// the row; this function never throws.
async function processForUser(userId) {
  await ensureSchema();
  const res = await db.query(
    `SELECT id, wallet_address, intent_type, from_token, to_token,
            from_amount, to_min_amount, status, expires_at
       FROM swap_waitlist
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [userId]
  );
  const out = { attempted: 0, executed: 0, expired: 0, deferred: 0, errors: [] };
  for (const row of res.rows) {
    out.attempted += 1;
    try {
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await db.query(
          `UPDATE swap_waitlist
              SET status = 'expired',
                  cancelled_at = NOW(),
                  cancel_reason = 'auto_expired'
            WHERE id = $1`,
          [row.id]
        );
        out.expired += 1;
        continue;
      }
      // Phase 1: we do NOT auto-execute the swap here (the DEX swap path
      // still requires the user's PIN-derived signing key, which we don't
      // hold without a session). What we do is mark the intent as
      // "ready" so the next time the user opens the app, the DEX page
      // sees a ready intent and can prompt them to confirm with one tap.
      await db.query(
        `UPDATE swap_waitlist
            SET status = 'ready',
                attempt_count = attempt_count + 1,
                last_error = NULL
          WHERE id = $1`,
        [row.id]
      );
      out.deferred += 1;
    } catch (e) {
      out.errors.push({ id: Number(row.id), message: e.message });
      try {
        await db.query(
          `UPDATE swap_waitlist
              SET attempt_count = attempt_count + 1,
                  last_error = $2
            WHERE id = $1`,
          [row.id, String(e.message || e).slice(0, 500)]
        );
      } catch (_) { /* swallow */ }
    }
  }
  return out;
}

async function routes(fastify) {
  await ensureSchema();

  fastify.post('/create', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      const body = req.body || {};

      const intentType = String(body.intentType || 'swap').trim().toLowerCase();
      if (!ALLOWED_INTENT_TYPES.has(intentType)) {
        return reply.code(400).send({ success: false, message: 'invalid intentType' });
      }

      const fromToken = normalizeToken(body.fromToken);
      const toToken = normalizeToken(body.toToken);
      if (!ALLOWED_TOKENS.has(fromToken) || !ALLOWED_TOKENS.has(toToken)) {
        return reply.code(400).send({ success: false, message: 'unsupported token' });
      }
      if (fromToken === toToken) {
        return reply.code(400).send({ success: false, message: 'fromToken and toToken must differ' });
      }

      const fromAmount = parseAmount(body.fromAmount, 'fromAmount');
      const toMinAmount = body.toMinAmount == null
        ? '0'
        : parseAmount(body.toMinAmount, 'toMinAmount');

      const expiresInDaysRaw = Number(body.expiresInDays || DEFAULT_EXPIRES_DAYS);
      const expiresInDays = Math.min(
        MAX_EXPIRES_DAYS,
        Math.max(1, Number.isFinite(expiresInDaysRaw) ? expiresInDaysRaw : DEFAULT_EXPIRES_DAYS)
      );

      // Resolve the user's wallet address.
      const uRes = await db.query(
        `SELECT id, wallet_address, custom_wallet_address
           FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const u = uRes.rows[0];
      if (!u) return reply.code(404).send({ success: false, message: 'user not found' });
      const walletAddress = String(u.wallet_address || u.custom_wallet_address || '').trim().toUpperCase();
      if (!walletAddress) {
        return reply.code(409).send({ success: false, message: 'no wallet on file' });
      }

      // Enforce per-user cap on pending intents.
      const countRes = await db.query(
        `SELECT COUNT(*)::int AS c
           FROM swap_waitlist
          WHERE user_id = $1 AND status IN ('pending','ready')`,
        [userId]
      );
      const pendingCount = Number(countRes.rows[0]?.c || 0);
      if (pendingCount >= MAX_INTENTS_PER_USER) {
        return reply.code(409).send({
          success: false,
          message: `you already have ${pendingCount} pending intents (max ${MAX_INTENTS_PER_USER}) — cancel one or wait for it to execute`,
        });
      }

      const ins = await db.query(
        `INSERT INTO swap_waitlist
           (user_id, wallet_address, intent_type, from_token, to_token,
            from_amount, to_min_amount, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + ($8 || ' days')::interval)
         RETURNING id, user_id, wallet_address, intent_type, from_token, to_token,
                   from_amount, to_min_amount, status, created_at, expires_at,
                   executed_at, executed_tx, cancelled_at, cancel_reason,
                   cancel_fee_tx, last_error, attempt_count`,
        [
          userId, walletAddress, intentType, fromToken, toToken,
          fromAmount, toMinAmount, String(expiresInDays),
        ]
      );

      return {
        success: true,
        intent: rowToView(ins.rows[0]),
        fee: {
          cancelFeeBnb: CANCEL_FEE_BNB,
          feeWallet: FEE_WALLET_READY ? FEE_WALLET_BNB : null,
          feeFlowReady: FEE_WALLET_READY,
        },
      };
    } catch (e) {
      const code = e.statusCode || 500;
      return reply.code(code).send({ success: false, message: e.message || 'create failed' });
    }
  });

  fastify.get('/mine', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req) => {
    const userId = req.user.userId;
    const res = await db.query(
      `SELECT id, user_id, wallet_address, intent_type, from_token, to_token,
              from_amount, to_min_amount, status, created_at, expires_at,
              executed_at, executed_tx, cancelled_at, cancel_reason,
              cancel_fee_tx, last_error, attempt_count
         FROM swap_waitlist
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [userId]
    );
    return {
      success: true,
      intents: res.rows.map(rowToView),
      fee: {
        cancelFeeBnb: CANCEL_FEE_BNB,
        feeWallet: FEE_WALLET_READY ? FEE_WALLET_BNB : null,
        feeFlowReady: FEE_WALLET_READY,
      },
    };
  });

  fastify.get('/:id', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ success: false, message: 'invalid id' });
    }
    const res = await db.query(
      `SELECT id, user_id, wallet_address, intent_type, from_token, to_token,
              from_amount, to_min_amount, status, created_at, expires_at,
              executed_at, executed_tx, cancelled_at, cancel_reason,
              cancel_fee_tx, last_error, attempt_count
         FROM swap_waitlist
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (!res.rows[0]) return reply.code(404).send({ success: false, message: 'not found' });
    return { success: true, intent: rowToView(res.rows[0]) };
  });

  fastify.delete('/:id', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, cancelHandler);

  // POST mirror of DELETE for clients (e.g. our mobile http helper) that
  // do not expose a DELETE primitive.
  fastify.post('/:id/cancel', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, cancelHandler);

  async function cancelHandler(req, reply) {
    const userId = req.user.userId;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ success: false, message: 'invalid id' });
    }

    const cur = await db.query(
      `SELECT id, status, expires_at FROM swap_waitlist
        WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    const row = cur.rows[0];
    if (!row) return reply.code(404).send({ success: false, message: 'not found' });
    if (row.status !== 'pending' && row.status !== 'ready') {
      return reply.code(409).send({
        success: false,
        message: `intent is already ${row.status}`,
        status: row.status,
      });
    }

    const isExpired = new Date(row.expires_at).getTime() < Date.now();
    const feeTx = String((req.body && req.body.feeTxHash) || '').trim();
    const requireFee = !isExpired; // expired intents cancel for free

    // Phase 2 enforcement (wired but currently soft-fails when fee infra
    // is not yet configured). Once DEX_FEE_WALLET_BNB is set on the
    // server, this becomes a hard requirement and the request below
    // must include feeTxHash that the BSC verifier accepts.
    if (requireFee && FEE_WALLET_READY) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(feeTx)) {
        return reply.code(402).send({
          success: false,
          message: `cancellation requires a BNB fee of ${CANCEL_FEE_BNB} BNB sent to ${FEE_WALLET_BNB} — include the BSC tx hash as feeTxHash`,
          feeRequired: true,
          feeAmountBnb: CANCEL_FEE_BNB,
          feeWallet: FEE_WALLET_BNB,
        });
      }
      // TODO(phase2): verify the BSC tx really paid `CANCEL_FEE_BNB` to
      // `FEE_WALLET_BNB`. For now we record the hash; a follow-up commit
      // will plug in the BSC RPC verifier before fee enforcement goes
      // live.
    }

    const reason = isExpired
      ? 'expired_before_cancel'
      : (FEE_WALLET_READY ? 'user_cancel_paid' : 'user_cancel_free_phase1');

    await db.query(
      `UPDATE swap_waitlist
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancel_reason = $2,
              cancel_fee_tx = NULLIF($3, '')
        WHERE id = $1`,
      [id, reason, feeTx || '']
    );

    return {
      success: true,
      cancelled: true,
      id,
      reason,
      feeAmountBnb: requireFee && FEE_WALLET_READY ? CANCEL_FEE_BNB : null,
      feeWallet: requireFee && FEE_WALLET_READY ? FEE_WALLET_BNB : null,
      note: FEE_WALLET_READY
        ? 'fee tx hash recorded; on-chain verification happens in Phase 2'
        : 'free cancellation (Phase 1 — BNB fee will apply once fee wallet is configured)',
    };
  }

  fastify.post('/process-for-me', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (req) => {
    const summary = await processForUser(req.user.userId);
    return { success: true, summary };
  });
}

module.exports = routes;
module.exports.processForUser = processForUser;
module.exports.ensureSchema = ensureSchema;
