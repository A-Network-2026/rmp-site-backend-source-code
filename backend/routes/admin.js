const db = require('../db');
const verifyToken = require('../middleware/auth');
const { REQUIRED_SESSIONS_FOR_ELIGIBILITY } = require('../services/miningEngine');

const RUN_ADMIN_SCHEMA_SYNC_STARTUP = String(process.env.RUN_ADMIN_SCHEMA_SYNC_STARTUP || 'false').trim().toLowerCase() === 'true';

let adminSchemaInitPromise = null;

function startAdminSchemaSetup(fastify) {
  if (!adminSchemaInitPromise) {
    adminSchemaInitPromise = (async () => {
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMP');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_anet NUMERIC(30, 8) DEFAULT 0');
    })();

    if (fastify) {
      adminSchemaInitPromise
        .then(() => {
          fastify.log.info('Admin startup schema checks completed');
        })
        .catch((err) => {
          fastify.log.error(err, 'Admin startup schema checks failed');
        });
    }
  }

  return adminSchemaInitPromise;
}

module.exports = async function (fastify) {
  if (RUN_ADMIN_SCHEMA_SYNC_STARTUP) {
    await startAdminSchemaSetup();
  } else {
    fastify.log.info('Admin startup schema checks skipped (RUN_ADMIN_SCHEMA_SYNC_STARTUP=false)');
  }

  // ── Admin check ────────────────────────────────────────────────────
  async function isAdmin(userId) {
    const raw = String(process.env.ADMIN_USER_IDS || '').trim();
    if (!raw) return false; // fail-closed: no admin if env var is not set
    const adminIds = raw
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
    return adminIds.includes(Number(userId));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 📊 ADMIN DASHBOARD — Eligible users (1,000+ sessions)
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/dashboard', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const eligibleRes = await db.query(`
      SELECT
        u.id,
        u.email,
        u.successful_sessions,
        u.ants_balance,
        u.claimed_anet,
        u.is_flagged,
        u.is_banned,
        u.risk_score,
        u.wallet_address,
        u.custom_wallet_address,
        u.created_at,
        u.last_activity_at,
        u.country,
        u.device_id,
        (SELECT COUNT(*)::int FROM mining_sessions ms
         WHERE ms.user_id = u.id AND ms.is_completed = TRUE) AS actual_completed_sessions
      FROM users u
      WHERE u.successful_sessions >= $1
        AND COALESCE(u.is_deleted, FALSE) = FALSE
      ORDER BY u.successful_sessions DESC
    `, [REQUIRED_SESSIONS_FOR_ELIGIBILITY]);

    const summaryRes = await db.query(`
      SELECT
        COUNT(*)::int AS total_eligible,
        COUNT(*) FILTER (WHERE COALESCE(claimed_anet, 0) > 0)::int AS already_claimed,
        COUNT(*) FILTER (WHERE COALESCE(is_banned, FALSE) = TRUE)::int AS banned_count,
        COUNT(*) FILTER (WHERE COALESCE(is_flagged, FALSE) = TRUE)::int AS flagged_count
      FROM users
      WHERE successful_sessions >= $1
        AND COALESCE(is_deleted, FALSE) = FALSE
    `, [REQUIRED_SESSIONS_FOR_ELIGIBILITY]);

    return {
      summary: summaryRes.rows[0],
      eligible_users: eligibleRes.rows,
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // 🔍 CHEATER DETECTION — Detect suspicious users
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/cheaters', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.user.userId || req.user.id;
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    // 1. Users with inflated sessions (successful_sessions > actual completed sessions)
    const inflatedRes = await db.query(`
      SELECT
        u.id, u.email, u.successful_sessions, u.risk_score, u.is_flagged,
        u.suspicious_flags, u.suspicious_reason, u.is_banned,
        u.device_id, u.last_ip, u.country, u.created_at,
        COUNT(ms.id)::int AS actual_sessions
      FROM users u
      LEFT JOIN mining_sessions ms ON ms.user_id = u.id AND ms.is_completed = TRUE AND ms.status = 'completed'
      WHERE COALESCE(u.is_deleted, FALSE) = FALSE
        AND u.successful_sessions > 0
      GROUP BY u.id
      HAVING u.successful_sessions > COUNT(ms.id)
      ORDER BY (u.successful_sessions - COUNT(ms.id)) DESC
      LIMIT 100
    `);

    // 2. High risk-score users (risk_score >= 5)
    const highRiskRes = await db.query(`
      SELECT id, email, risk_score, is_flagged, flag_reason,
             suspicious_flags, suspicious_reason, successful_sessions,
             is_banned, device_id, last_ip, country, created_at
      FROM users
      WHERE risk_score >= 5
        AND COALESCE(is_deleted, FALSE) = FALSE
      ORDER BY risk_score DESC
      LIMIT 100
    `);

    // 3. Users with suspiciously fast session completions (< 5.5 hours)
    const fastSessionsRes = await db.query(`
      SELECT
        u.id, u.email, u.successful_sessions, u.is_banned,
        COUNT(ms.id)::int AS fast_sessions,
        ROUND(AVG(EXTRACT(EPOCH FROM (ms.end_time - ms.start_time)) / 3600)::numeric, 2) AS avg_hours
      FROM users u
      JOIN mining_sessions ms ON ms.user_id = u.id
        AND ms.is_completed = TRUE
        AND ms.status = 'completed'
        AND ms.end_time IS NOT NULL
        AND EXTRACT(EPOCH FROM (ms.end_time - ms.start_time)) < 19800
      WHERE COALESCE(u.is_deleted, FALSE) = FALSE
      GROUP BY u.id
      HAVING COUNT(ms.id) >= 3
      ORDER BY COUNT(ms.id) DESC
      LIMIT 50
    `);

    // 4. Users with too many sessions per day (> 4 in any single day)
    const overDailyLimitRes = await db.query(`
      SELECT
        u.id, u.email, u.successful_sessions, u.is_banned,
        d.session_date,
        d.daily_count
      FROM (
        SELECT user_id, DATE(start_time) AS session_date, COUNT(*)::int AS daily_count
        FROM mining_sessions
        WHERE is_completed = TRUE AND status = 'completed'
        GROUP BY user_id, DATE(start_time)
        HAVING COUNT(*) > 4
      ) d
      JOIN users u ON u.id = d.user_id
      WHERE COALESCE(u.is_deleted, FALSE) = FALSE
      ORDER BY d.daily_count DESC
      LIMIT 50
    `);

    // 5. Multi-account clusters (same device, different users)
    const deviceClustersRes = await db.query(`
      SELECT device_id,
             ARRAY_AGG(JSON_BUILD_OBJECT(
               'id', id, 'email', email, 'sessions', successful_sessions,
               'is_banned', COALESCE(is_banned, FALSE), 'risk_score', risk_score
             )) AS accounts,
             COUNT(*)::int AS account_count
      FROM users
      WHERE device_id IS NOT NULL
        AND TRIM(device_id) <> ''
        AND COALESCE(is_deleted, FALSE) = FALSE
      GROUP BY device_id
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC
      LIMIT 30
    `);

    return {
      inflated_sessions: inflatedRes.rows,
      high_risk: highRiskRes.rows,
      fast_sessions: fastSessionsRes.rows,
      over_daily_limit: overDailyLimitRes.rows,
      device_clusters: deviceClustersRes.rows,
      thresholds: {
        risk_score_alert: 5,
        fast_session_hours: 5.5,
        daily_session_limit: 4,
        device_cluster_min: 2,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // 🔨 BAN USER
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/ban', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const adminUserId = req.user.userId || req.user.id;
    if (!(await isAdmin(adminUserId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { targetUserId, reason } = req.body || {};
    if (!targetUserId) {
      return reply.code(400).send({ error: 'targetUserId is required' });
    }

    // Prevent banning self
    if (Number(targetUserId) === Number(adminUserId)) {
      return reply.code(400).send({ error: 'Cannot ban yourself' });
    }

    const result = await db.query(`
      UPDATE users
      SET is_banned = TRUE,
          banned_at = NOW(),
          ban_reason = $2,
          is_mining = FALSE
      WHERE id = $1
        AND COALESCE(is_deleted, FALSE) = FALSE
      RETURNING id, email, is_banned
    `, [targetUserId, reason || 'Banned by admin']);

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    // Cancel any active mining sessions
    await db.query(`
      UPDATE mining_sessions
      SET status = 'cancelled', is_completed = FALSE, end_time = NOW()
      WHERE user_id = $1 AND status = 'active'
    `, [targetUserId]);

    return {
      message: `User ${result.rows[0].email} has been banned.`,
      user: result.rows[0],
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // ✅ UNBAN USER
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/unban', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const adminUserId = req.user.userId || req.user.id;
    if (!(await isAdmin(adminUserId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { targetUserId } = req.body || {};
    if (!targetUserId) {
      return reply.code(400).send({ error: 'targetUserId is required' });
    }

    const result = await db.query(`
      UPDATE users
      SET is_banned = FALSE,
          banned_at = NULL,
          ban_reason = NULL
      WHERE id = $1
        AND COALESCE(is_deleted, FALSE) = FALSE
      RETURNING id, email, is_banned
    `, [targetUserId]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return {
      message: `User ${result.rows[0].email} has been unbanned.`,
      user: result.rows[0],
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // 🔍 USER DETAIL — Deep view of a single user for admin review
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/user/:targetUserId', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const adminUserId = req.user.userId || req.user.id;
    if (!(await isAdmin(adminUserId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const { targetUserId } = req.params;

    const userRes = await db.query(`
      SELECT id, email, successful_sessions, ants_balance, claimed_anet,
             is_flagged, flag_reason, is_banned, ban_reason, banned_at,
             risk_score, suspicious_flags, suspicious_reason,
             wallet_address, custom_wallet_address, device_id,
             device_fingerprint, last_ip, country,
             is_mining, last_mining_start, email_verified,
             created_at, last_activity_at, updated_at
      FROM users WHERE id = $1
    `, [targetUserId]);

    if (userRes.rows.length === 0) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const sessionsRes = await db.query(`
      SELECT id, start_time, end_time, reward, halving_level,
             heartbeat_count, is_flagged, is_completed, status,
             started_ip, completed_ip,
             ROUND(EXTRACT(EPOCH FROM (end_time - start_time)) / 3600.0, 2) AS duration_hours
      FROM mining_sessions
      WHERE user_id = $1
      ORDER BY start_time DESC
      LIMIT 50
    `, [targetUserId]);

    const auditRes = await db.query(`
      SELECT event_type, ip, device_id, risk_points, details, created_at
      FROM security_audit_logs
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 30
    `, [targetUserId]);

    return {
      user: userRes.rows[0],
      recent_sessions: sessionsRes.rows,
      audit_log: auditRes.rows,
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // ⛏️  GET /miners — Paginated list of all miners with session data
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/miners', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const adminUserId = req.user.userId || req.user.id;
    if (!(await isAdmin(adminUserId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.min(100000, Math.max(0, Number(req.query.offset) || 0));
    const sessionLimit = Math.min(50, Math.max(1, Number(req.query.sessionLimit) || 10));

    const minersRes = await db.query(`
      SELECT
        u.id, u.email, u.successful_sessions, u.ants_balance, u.claimed_anet,
        u.is_flagged, u.is_banned, u.risk_score, u.wallet_address,
        u.custom_wallet_address, u.country, u.created_at, u.last_activity_at,
        u.is_mining, u.last_mining_start,
        COUNT(ms.id)::int AS total_sessions
      FROM users u
      LEFT JOIN mining_sessions ms ON ms.user_id = u.id
      WHERE COALESCE(u.is_deleted, FALSE) = FALSE
      GROUP BY u.id
      ORDER BY u.last_activity_at DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const summaryRes = await db.query(`
      SELECT
        COUNT(*)::int AS total_miners,
        COUNT(*) FILTER (WHERE COALESCE(is_mining, FALSE) = TRUE)::int AS active_miners,
        COALESCE((SELECT COUNT(*)::int FROM mining_sessions WHERE is_completed = TRUE), 0) AS total_recorded_sessions
      FROM users
      WHERE COALESCE(is_deleted, FALSE) = FALSE
    `);

    const miners = minersRes.rows;
    if (miners.length > 0 && sessionLimit > 0) {
      const ids = miners.map((m) => m.id);
      try {
        const sessionsRes = await db.query(`
          SELECT DISTINCT ON (user_id) *
          FROM (
            SELECT user_id, id, start_time, end_time, reward, is_completed, status,
                   ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY start_time DESC) AS rn
            FROM mining_sessions
            WHERE user_id = ANY($1::int[])
          ) ranked
          WHERE rn <= $2
          ORDER BY user_id, start_time DESC
        `, [ids, sessionLimit]);
        const sessionsByUser = {};
        for (const row of sessionsRes.rows) {
          if (!sessionsByUser[row.user_id]) sessionsByUser[row.user_id] = [];
          sessionsByUser[row.user_id].push(row);
        }
        for (const m of miners) {
          m.recent_sessions = sessionsByUser[m.id] || [];
        }
      } catch (_) {
        for (const m of miners) {
          m.recent_sessions = [];
        }
      }
    }

    return {
      miners,
      summary: summaryRes.rows[0] || { total_miners: 0, active_miners: 0, total_recorded_sessions: 0 },
      limit,
      offset,
      session_limit: sessionLimit,
    };
  });
};
