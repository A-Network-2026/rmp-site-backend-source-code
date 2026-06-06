'use strict';

/**
 * validator.js — A Network Validator API Routes
 *
 * Prefix: /validator
 *
 * Public (authenticated):
 *   GET  /validator/status              — own validator profile + gate breakdown
 *   POST /validator/activate            — promote ELIGIBLE → ACTIVE
 *   GET  /validator/tasks               — pending validation tasks
 *   POST /validator/tasks/:taskId/submit — submit VALID | INVALID | ABSTAIN
 *   GET  /validator/stats               — stats + reward breakdown
 *   GET  /validator/history             — validation task history
 *   GET  /validator/leaderboard         — top validators (no auth required)
 *
 * Admin only (ADMIN_USER_IDS env var):
 *   POST /validator/admin/suspend/:userId
 *   POST /validator/admin/reactivate/:userId
 *   GET  /validator/admin/validators
 */

const db          = require('../db');
const verifyToken = require('../middleware/auth');
const {
  STATUS,
  ensureValidatorSchema,
  checkAndSyncEligibility,
  activateValidator,
  suspendValidator,
  reactivateValidator,
  submitValidationResult,
  getValidatorProfile,
  getValidatorStats,
  getLeaderboard,
  listValidators,
  getValidationHistory,
  getPendingTasks,
} = require('../services/validatorEngine');

// ── Admin helper ──────────────────────────────────────────────────────

function _isAdmin(userId) {
  return String(process.env.ADMIN_USER_IDS || '1')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))
    .includes(Number(userId));
}

// ── Plugin ────────────────────────────────────────────────────────────

module.exports = async function validatorRoutes(fastify) {
  // Warn on boot if migration has not been run yet
  try {
    await ensureValidatorSchema(db);
  } catch (err) {
    fastify.log.warn(
      { err: err.message },
      'Validator schema not ready — run migration_validator_system_2026_05_15.sql'
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // GET /validator/status
  // Own validator profile: status, all 5 gate results, reputation, etc.
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/status', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId;
    try {
      const profile = await getValidatorProfile(userId, db);
      if (!profile) return reply.code(404).send({ error: 'User not found' });
      return { profile };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to load validator status' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /validator/activate
  // Re-evaluates eligibility, then promotes ELIGIBLE → ACTIVE.
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/activate', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId;
    try {
      // Re-sync gates before allowing activation
      await checkAndSyncEligibility(userId, db);
      const result = await activateValidator(userId, db);
      return { success: true, ...result };
    } catch (err) {
      if (err.code === 'NOT_ELIGIBLE') {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      if (err.code === 'SUSPENDED') {
        return reply.code(403).send({ error: err.message, code: err.code });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to activate validator' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /validator/tasks
  // Pending validation tasks assigned to the calling user.
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/tasks', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId;
    try {
      const tasks = await getPendingTasks(userId, db);
      return { tasks };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to load tasks' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // POST /validator/tasks/:taskId/submit
  // Body: { "result": "VALID" | "INVALID" | "ABSTAIN" }
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/tasks/:taskId/submit', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId;
    const taskId = String(req.params.taskId || '').trim();
    const result = String((req.body ?? {}).result || '').trim().toUpperCase();

    if (!taskId) return reply.code(400).send({ error: 'Missing taskId' });
    if (!result) return reply.code(400).send({ error: 'Missing result (VALID | INVALID | ABSTAIN)' });

    try {
      const data = await submitValidationResult(taskId, userId, result, db);
      return { success: true, ...data };
    } catch (err) {
      const map = {
        NOT_FOUND:        404,
        FORBIDDEN:        403,
        ALREADY_SUBMITTED: 409,
        EXPIRED:          410,
        INVALID_RESULT:   400,
      };
      const code = map[err.code];
      if (code) return reply.code(code).send({ error: err.message, code: err.code });
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to submit validation result' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /validator/stats
  // Full stats: accuracy, rewards breakdown, streak, reputation.
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/stats', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId;
    try {
      const stats = await getValidatorStats(userId, db);
      if (!stats) return reply.code(404).send({ error: 'User not found' });
      return { stats };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to load validator stats' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /validator/history?limit=20&offset=0
  // Completed, expired, and skipped task history.
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/history', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId;
    const limit  = Math.min(Number(req.query.limit  ?? 20),  100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    try {
      const history = await getValidationHistory(userId, limit, offset, db);
      return { history, limit, offset };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to load validation history' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // GET /validator/leaderboard?limit=50
  // Top validators by reputation (no auth required — public).
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/leaderboard', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 100);
    try {
      const leaderboard = await getLeaderboard(limit, db);
      return { leaderboard };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to load leaderboard' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN: POST /validator/admin/suspend/:userId
  // Body: { "reason": "optional reason string" }
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/admin/suspend/:userId', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!_isAdmin(req.user.userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const targetId = Number(req.params.userId);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply.code(400).send({ error: 'Invalid userId' });
    }
    const reason = String((req.body ?? {}).reason || 'Administrative suspension').slice(0, 255);
    try {
      await suspendValidator(targetId, reason, db);
      return { success: true, userId: targetId, status: STATUS.SUSPENDED };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to suspend validator' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN: POST /validator/admin/reactivate/:userId
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/admin/reactivate/:userId', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!_isAdmin(req.user.userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const targetId = Number(req.params.userId);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return reply.code(400).send({ error: 'Invalid userId' });
    }
    try {
      await reactivateValidator(targetId, db);
      return { success: true, userId: targetId, status: STATUS.ACTIVE };
    } catch (err) {
      if (err.code === 'NOT_ELIGIBLE') {
        return reply.code(400).send({ error: err.message, code: err.code, gates: err.gates });
      }
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to reactivate validator' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // ADMIN: GET /validator/admin/validators?status=ACTIVE&limit=50&offset=0
  // List all validator profiles with optional status filter.
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/admin/validators', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!_isAdmin(req.user.userId)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const statusFilter = String(req.query.status || 'ALL').toUpperCase();
    const limit  = Math.min(Number(req.query.limit  ?? 50),  200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    try {
      const validators = await listValidators(statusFilter, limit, offset, db);
      return { validators, filter: statusFilter, limit, offset };
    } catch (err) {
      fastify.log.error(err);
      return reply.code(500).send({ error: 'Failed to list validators' });
    }
  });
};
