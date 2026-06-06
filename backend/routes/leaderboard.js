const db = require('../db');
const { antsToAnet } = require('../services/miningEngine');

const LEADERBOARD_TOP_CACHE_MS = Math.max(1000, Number(process.env.LEADERBOARD_TOP_CACHE_MS || 5000));
const LEADERBOARD_RANK_CACHE_MS = Math.max(1000, Number(process.env.LEADERBOARD_RANK_CACHE_MS || 10000));
const LEADERBOARD_RANK_STALE_MS = Math.max(5000, Number(process.env.LEADERBOARD_RANK_STALE_MS || 120000));
const LEADERBOARD_DB_WAITING_THRESHOLD = Math.max(3, Number(process.env.LEADERBOARD_DB_WAITING_THRESHOLD || 8));

let topCache = { expiresAt: 0, payload: null };
const rankCache = new Map();

function getRankCache(userId, options = {}) {
  const includeStale = Boolean(options.includeStale);
  const cached = rankCache.get(String(userId));
  if (!cached) return null;
  const now = Date.now();
  if (cached.expiresAt > now) {
    return cached.payload;
  }
  if (includeStale && cached.staleUntil > now) {
    return cached.payload;
  }
  if (cached.staleUntil <= now) {
    rankCache.delete(String(userId));
  }
  return null;
}

function setRankCache(userId, payload) {
  rankCache.set(String(userId), {
    payload,
    expiresAt: Date.now() + LEADERBOARD_RANK_CACHE_MS,
    staleUntil: Date.now() + LEADERBOARD_RANK_CACHE_MS + LEADERBOARD_RANK_STALE_MS,
  });
  if (rankCache.size > 10000) {
    const oldestKey = rankCache.keys().next().value;
    if (oldestKey) rankCache.delete(oldestKey);
  }
}

module.exports = async function (fastify) {
  const readQuery = typeof db.readQuery === 'function' ? db.readQuery : db.query;

  function isDbPressureHigh() {
    const waitingCount = Number(db.waitingCount || 0);
    return Number.isFinite(waitingCount) && waitingCount >= LEADERBOARD_DB_WAITING_THRESHOLD;
  }

  /// 🏆 TOP USERS
  fastify.get('/top', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async () => {
    try {
      const now = Date.now();
      if (topCache.payload && topCache.expiresAt > now) {
        return topCache.payload;
      }

      if (topCache.payload && isDbPressureHigh()) {
        return topCache.payload;
      }

      const result = await readQuery(`
        SELECT
          id,
          email,
          balance,
          GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) AS ant_balance,
          successful_sessions
        FROM users
        ORDER BY GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) DESC, id ASC
        LIMIT 20
      `);

      const payload = result.rows.map((row) => ({
        ...row,
        ant_balance: Number(row.ant_balance || 0),
        balance: antsToAnet(row.ant_balance || 0),
      }));

      topCache = {
        payload,
        expiresAt: Date.now() + LEADERBOARD_TOP_CACHE_MS,
      };

      return payload;
    } catch (err) {
      fastify.log.warn({ err }, 'Leaderboard /top failed, returning cached payload if available');
      if (topCache.payload) {
        return topCache.payload;
      }
      return { error: 'Leaderboard temporarily unavailable' };
    }
  });

  /// 👤 USER RANK
  fastify.get('/rank/:userId', {
    config: {
      rateLimit: { max: 15, timeWindow: '1 minute' },
    },
  }, async (req) => {
    const { userId } = req.params;
    const id = parseInt(userId, 10);
    if (!id || isNaN(id)) return { error: 'Invalid userId' };

    const cached = getRankCache(id);
    if (cached) {
      return cached;
    }

    if (isDbPressureHigh()) {
      const staleCached = getRankCache(id, { includeStale: true });
      if (staleCached) {
        return staleCached;
      }
      return { error: 'Leaderboard temporarily unavailable' };
    }

    let result;
    try {
      result = await readQuery(`
        WITH rank_subject AS (
          SELECT
            id,
            balance,
            GREATEST(COALESCE(ants_balance, 0)::numeric, COALESCE(ant_balance, 0)) AS ant_balance
          FROM users
          WHERE id = $1
        )
        SELECT
          rs.id,
          rs.balance,
          rs.ant_balance,
          (
            SELECT COUNT(*)::int + 1
            FROM users u2
            WHERE GREATEST(COALESCE(u2.ants_balance, 0)::numeric, COALESCE(u2.ant_balance, 0)) > rs.ant_balance
               OR (
                 GREATEST(COALESCE(u2.ants_balance, 0)::numeric, COALESCE(u2.ant_balance, 0)) = rs.ant_balance
                 AND u2.id < rs.id
               )
          ) AS rank
        FROM rank_subject rs
      `, [id]);
    } catch (err) {
      fastify.log.warn({ err, userId: id }, 'Leaderboard /rank query failed');
      const staleCached = getRankCache(id, { includeStale: true });
      if (staleCached) {
        return staleCached;
      }
      return { error: 'Leaderboard temporarily unavailable' };
    }

    if (!result.rows[0]) {
      return { error: 'User not found' };
    }

    const payload = {
      ...result.rows[0],
      ant_balance: Number(result.rows[0].ant_balance || 0),
      balance: antsToAnet(result.rows[0].ant_balance || 0),
    };

    setRankCache(id, payload);
    return payload;
  });

};