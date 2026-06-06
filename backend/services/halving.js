const db = require('../db');
const {
  MAX_HALVING_STAGE,
  HALVING_INTERVAL,
  getHalvingStage,
} = require('./miningEngine');

const HALVING_REFRESH_MS = Math.max(5000, Number(process.env.HALVING_REFRESH_MS || 60000));
let halvingCache = { expiresAt: 0, payload: null };
let halvingInflight = null;

async function computeHalvingSnapshot() {
  const totalsRes = await db.query(`
    SELECT
      COUNT(*)::bigint AS total_users,
      COUNT(*) FILTER (WHERE successful_sessions >= 1000)::bigint AS qualified_users,
      COUNT(*) FILTER (WHERE is_mining = TRUE)::bigint AS active_miners,
      COUNT(*) FILTER (WHERE COALESCE(claimed_anet, 0) > 0)::bigint AS converted_users,
      COALESCE(SUM(successful_sessions), 0)::bigint AS total_sessions
    FROM users
    WHERE COALESCE(is_deleted, FALSE) = FALSE
  `);

  const totalUsers = Number(totalsRes.rows[0]?.total_users || 0);
  const qualifiedUsers = Number(totalsRes.rows[0]?.qualified_users || 0);
  const totalActiveMiners = Number(totalsRes.rows[0]?.active_miners || 0);
  const totalConvertedUsers = Number(totalsRes.rows[0]?.converted_users || 0);
  const totalSessions = Number(totalsRes.rows[0]?.total_sessions || 0);

  const halvingStage = getHalvingStage(totalSessions);

  const qualifiedRes = await db.query(`
    UPDATE network_stats
    SET total_users = $1,
        eligible_users = $2,
        total_sessions = $3,
        halving_count = $4,
        updated_at = NOW()
    RETURNING id
  `, [totalUsers, qualifiedUsers, totalSessions, halvingStage]);

  if (!qualifiedRes.rows[0]?.id) {
    await db.query(`
      INSERT INTO network_stats (id, total_users, eligible_users, total_sessions, halving_count, total_mined, total_mined_ants, total_anet_distributed, is_mining_active)
      VALUES (1, $1, $2, $3, $4, 0, 0, 0, TRUE)
      ON CONFLICT (id) DO UPDATE
      SET total_users = EXCLUDED.total_users,
          eligible_users = EXCLUDED.eligible_users,
          total_sessions = EXCLUDED.total_sessions,
          halving_count = EXCLUDED.halving_count,
          updated_at = NOW()
    `, [totalUsers, qualifiedUsers, totalSessions, halvingStage]);
  }

  return {
    totalUsers,
    qualifiedUsers,
    totalActiveMiners,
    totalConvertedUsers,
    totalSessions,
    halvingInterval: HALVING_INTERVAL,
    halvingStage,
    rawHalvingStage: Math.floor(totalSessions / HALVING_INTERVAL),
    maxHalvingStage: MAX_HALVING_STAGE,
  };
}

async function updateHalving(options = {}) {
  const force = Boolean(options.force);
  const now = Date.now();

  if (!force && halvingCache.payload && halvingCache.expiresAt > now) {
    return halvingCache.payload;
  }

  if (!halvingInflight) {
    halvingInflight = (async () => {
      const payload = await computeHalvingSnapshot();
      halvingCache = {
        payload,
        expiresAt: Date.now() + HALVING_REFRESH_MS,
      };
      return payload;
    })().finally(() => {
      halvingInflight = null;
    });
  }

  try {
    return await halvingInflight;
  } catch (err) {
    if (halvingCache.payload) {
      return halvingCache.payload;
    }
    throw err;
  }
}

module.exports = { updateHalving };