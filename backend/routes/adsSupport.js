const db = require('../db');
const verifyToken = require('../middleware/auth');
const { logAudit } = require('../services/antiAbuse');

function readAuthUserId(req) {
  return req?.user?.userId || req?.user?.id || null;
}

function getExpectedImpressionToken() {
  return String(process.env.ADS_IMPRESSION_TOKEN || '').trim();
}

function intFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

function readAdminIds() {
  return String(process.env.ADMIN_USER_IDS || '1')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v));
}

const ADS_IMPRESSION_DEDUPE_WINDOW_MS = Math.max(
  1000,
  Number(process.env.ADS_IMPRESSION_DEDUPE_WINDOW_MS || 8000)
);
const recentImpressionCache = new Map();

function makeImpressionKey(userId, adType, adUnitId) {
  return `${userId}:${String(adType || '').trim().toLowerCase()}:${String(adUnitId || '').trim()}`;
}

function isRecentDuplicateImpression(userId, adType, adUnitId) {
  const key = makeImpressionKey(userId, adType, adUnitId);
  const now = Date.now();
  const lastAt = Number(recentImpressionCache.get(key) || 0);
  recentImpressionCache.set(key, now);

  if (recentImpressionCache.size > 50000) {
    const oldestKey = recentImpressionCache.keys().next().value;
    if (oldestKey) recentImpressionCache.delete(oldestKey);
  }

  return now - lastAt < ADS_IMPRESSION_DEDUPE_WINDOW_MS;
}

function isAdmin(userId) {
  return readAdminIds().includes(Number(userId));
}

module.exports = async function (fastify) {
  fastify.post('/api/ads/impression', {
    preHandler: verifyToken,
    config: {
      rateLimit: {
        max: intFromEnv('ADS_IMPRESSION_RATE_MAX_PER_MIN', 30),
        timeWindow: '1 minute',
      },
    },
  }, async (req, reply) => {
    try {
      const userId = readAuthUserId(req);
      if (!userId) {
        return reply.code(401).send({ success: false, error: 'Unauthorized' });
      }

      const expectedToken = getExpectedImpressionToken();
      if (expectedToken) {
        const providedToken = String(
          req.headers['x-ads-support-token'] || req.body?.clientToken || ''
        ).trim();

        if (!providedToken || providedToken !== expectedToken) {
          await logAudit(db, {
            eventType: 'ads_impression_rejected_invalid_token',
            userId,
            ip: req.ip,
            details: {
              adUnitId: req.body?.adUnitId || null,
            },
          });
          return reply.code(403).send({ success: false, error: 'Invalid impression token' });
        }
      }

      const adType = String(req.body?.adType || '').trim().toLowerCase();
      const adUnitId = String(req.body?.adUnitId || '').trim();
      if (isRecentDuplicateImpression(userId, adType, adUnitId)) {
        return {
          success: true,
          deduped: true,
        };
      }

      const userRes = await db.query(
        `SELECT COALESCE(ads_active, TRUE) AS ads_active
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId]
      );

      if (!userRes.rows[0]) {
        return reply.code(404).send({ success: false, error: 'User not found' });
      }

      if (!Boolean(userRes.rows[0].ads_active)) {
        await logAudit(db, {
          eventType: 'ads_impression_rejected_inactive',
          userId,
          ip: req.ip,
          details: {
            adUnitId: req.body?.adUnitId || null,
          },
        });
        return reply.code(409).send({ success: false, error: 'Ads are currently inactive for this user' });
      }

      const updated = await db.query(
        `UPDATE users
         SET total_ad_impressions = COALESCE(total_ad_impressions, 0) + 1,
             ads_last_seen_at = NOW(),
             ads_last_active_at = NOW(),
             ads_started_at = COALESCE(ads_started_at, NOW()),
             updated_at = NOW()
         WHERE id = $1
         RETURNING total_ad_impressions`,
        [userId]
      );

      if (!updated.rows[0]) {
        return reply.code(404).send({ success: false, error: 'User not found' });
      }

      const spikeWindowMinutes = intFromEnv('ADS_IMPRESSION_SPIKE_WINDOW_MINUTES', 10);
      const spikeThreshold = intFromEnv('ADS_IMPRESSION_SPIKE_THRESHOLD', 120);
      const spikeRes = await db.query(
        `SELECT COUNT(*)::int AS cnt
         FROM security_audit_logs
         WHERE user_id = $1
           AND event_type = 'ads_impression_recorded'
           AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')`,
        [userId, spikeWindowMinutes]
      );
      const recentCount = Number(spikeRes.rows[0]?.cnt || 0);

      await logAudit(db, {
        eventType: 'ads_impression_recorded',
        userId,
        ip: req.ip,
        details: {
          adType: adType || null,
          adUnitId: adUnitId || null,
          totalAdImpressions: Number(updated.rows[0].total_ad_impressions || 0),
          sdk: req.body?.sdk || null,
        },
      });

      if (recentCount >= spikeThreshold) {
        await logAudit(db, {
          eventType: 'ads_impression_spike_detected',
          userId,
          ip: req.ip,
          details: {
            windowMinutes: spikeWindowMinutes,
            threshold: spikeThreshold,
            recentCount,
            adUnitId: req.body?.adUnitId || null,
          },
        });
      }

      return {
        success: true,
        total_ad_impressions: Number(updated.rows[0].total_ad_impressions || 0),
      };
    } catch (err) {
      console.error('[AdsSupport] impression failed:', err.message || err);
      return reply.code(500).send({ success: false, error: 'Failed to record ad impression' });
    }
  });

  fastify.get('/api/user/profile', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 80, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    try {
      const userId = readAuthUserId(req);
      if (!userId) {
        return reply.code(401).send({ success: false, error: 'Unauthorized' });
      }

      const result = await db.query(
        `SELECT COALESCE(supporter_badge, FALSE) AS supporter_badge,
          supporter_since,
          COALESCE(total_ad_impressions, 0) AS total_ad_impressions
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId]
      );

      const row = result.rows[0];
      if (!row) {
        return reply.code(404).send({ success: false, error: 'User not found' });
      }

      return {
        success: true,
        supporter_badge: Boolean(row.supporter_badge),
        supporter_since: row.supporter_since || null,
        total_ad_impressions: Number(row.total_ad_impressions || 0),
        message:
          'Ads in A Network help support Web3 infrastructure and ecosystem growth. They do not affect mining or rewards.',
      };
    } catch (err) {
      console.error('[AdsSupport] profile failed:', err.message || err);
      return reply.code(500).send({ success: false, error: 'Failed to load profile' });
    }
  });

  fastify.get('/api/ads/admin/watchers', {
    preHandler: verifyToken,
    config: {
      rateLimit: { max: 40, timeWindow: '1 minute' },
    },
  }, async (req, reply) => {
    const adminUserId = readAuthUserId(req);
    if (!isAdmin(adminUserId)) {
      return reply.code(403).send({ success: false, error: 'Admin access required' });
    }

    const limit = Math.min(500, Math.max(1, Number(req.query?.limit || 100)));
    const offset = Math.max(0, Number(req.query?.offset || 0));

    const summaryRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE COALESCE(total_ad_impressions, 0) > 0)::int AS users_with_ad_impressions,
         COALESCE(SUM(COALESCE(total_ad_impressions, 0)), 0)::bigint AS total_ad_impressions,
         COUNT(*) FILTER (WHERE COALESCE(ads_last_seen_at, NOW() - INTERVAL '100 years') >= NOW() - INTERVAL '24 hours')::int AS active_last_24h
       FROM users
       WHERE COALESCE(is_deleted, FALSE) = FALSE`
    );

    const watchersRes = await db.query(
      `SELECT
         u.id,
         u.email,
         COALESCE(u.total_ad_impressions, 0) AS total_ad_impressions,
         u.ads_started_at,
         u.ads_last_seen_at,
         u.supporter_badge,
         u.supporter_since,
         COALESCE(recent.recent_impressions_24h, 0) AS recent_impressions_24h
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(*)::int AS recent_impressions_24h
         FROM security_audit_logs
         WHERE event_type = 'ads_impression_recorded'
           AND created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY user_id
       ) recent ON recent.user_id = u.id
       WHERE COALESCE(u.is_deleted, FALSE) = FALSE
         AND COALESCE(u.total_ad_impressions, 0) > 0
       ORDER BY COALESCE(u.total_ad_impressions, 0) DESC, u.id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return {
      success: true,
      summary: summaryRes.rows[0] || {
        users_with_ad_impressions: 0,
        total_ad_impressions: 0,
        active_last_24h: 0,
      },
      pagination: {
        limit,
        offset,
        returned: watchersRes.rows.length,
      },
      watchers: watchersRes.rows,
    };
  });
};
