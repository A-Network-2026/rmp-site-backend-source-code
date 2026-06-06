const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const verifyToken = require('../middleware/auth');
const { triggerNotificationFallback } = require('../services/notificationWorker');
const { MAX_SESSIONS, ANET_CONVERSION } = require('../constants/economics');

module.exports = async function (fastify) {

  fastify.post('/create', async (req, reply) => {
    // Requires a server-side internal key — never expose this endpoint unauthenticated.
    const internalKey = process.env.USER_CREATE_INTERNAL_KEY || '';
    if (!internalKey || req.headers['x-internal-key'] !== internalKey) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const uuid = uuidv4();
    const result = await db.query(`
      INSERT INTO users (uuid, ads_active, ads_started_at)
      VALUES ($1, TRUE, NOW())
      RETURNING id, uuid, ads_active, ads_started_at
    `, [uuid]);
    return result.rows[0];
  });

  fastify.get('/dashboard', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    try {
      const userId = req.user.userId || req.user.id;

      const rowRes = await db.query(
        `SELECT
            id,
            COALESCE(successful_sessions, 0)::int AS successful_sessions,
            COALESCE(progress_percent, 0) AS progress_percent,
            GREATEST(
              COALESCE(ants_balance, 0),
              COALESCE(ant_balance, 0)::bigint
            ) AS ants_balance,
            COALESCE(is_eligible, FALSE) AS is_eligible,
            session_end_time,
            notification_sent
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId]
      );

      const user = rowRes.rows[0];
      if (!user) {
        return reply.code(404).send({ success: false, message: 'User not found' });
      }

      if (user.session_end_time && new Date(user.session_end_time) <= new Date() && !user.notification_sent) {
        await triggerNotificationFallback(userId);
      }

      const totalSessions = Number(user.successful_sessions || 0);
      const antsBalance = BigInt(String(user.ants_balance || '0'));
      const anetBalance = Number(antsBalance) / Number(ANET_CONVERSION);
      let badge = 'Starter';
      if (totalSessions >= 1000) {
        badge = 'Qualified';
      } else if (totalSessions >= 500) {
        badge = 'Advanced';
      } else if (totalSessions >= 100) {
        badge = 'Consistent';
      } else if (totalSessions >= 1) {
        badge = 'Beginner';
      }

      const level = Math.max(1, Math.floor(totalSessions / 25) + 1);

      return {
        success: true,
        data: {
          total_sessions: totalSessions,
          completed_sessions: totalSessions,
          progress_percent: Number(((totalSessions / MAX_SESSIONS) * 100).toFixed(4)),
          sessions_left: Math.max(0, MAX_SESSIONS - totalSessions),
          ants_balance: Number(antsBalance),
          anet_balance: Number(anetBalance.toFixed(8)),
          is_eligible: Boolean(user.is_eligible),
          badge,
          level,
          achievements: {
            first_session: totalSessions >= 1,
            streak_7_days: false,
            referral_5: false,
          },
        },
      };
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ success: false, message: 'Failed to load dashboard' });
    }
  });

};