const db = require('../db');
const { calculateRate } = require('../services/miningEngine');

module.exports = async function (fastify) {

  /// 🌐 GET NETWORK STATS
  fastify.get('/network', async () => {
    try {

      /// total users
      const usersRes = await db.query(`SELECT COUNT(*) FROM users`);
      const totalUsers = parseInt(usersRes.rows[0].count);

      /// network stats
      const netRes = await db.query(`SELECT * FROM network_stats`);
      const stats = netRes.rows[0];

      /// current mining rate
      const currentRate = calculateRate(stats.halving_count);

      /// progress to next halving
      const nextHalvingTarget = 210000;
      const progress =
        stats.eligible_users % nextHalvingTarget;

      return {
        totalUsers,
        eligibleUsers: stats.eligible_users,
        halvingCount: stats.halving_count,
        totalMined: stats.total_mined,
        isMiningActive: stats.is_mining_active,
        currentRate,
        nextHalvingProgress: progress,
        nextHalvingTarget
      };

    } catch (err) {
      console.error(err);
      return { error: "Failed to fetch stats" };
    }
  });

};