const db = require('../db');
const verifyToken = require('../middleware/auth');
const { updateHalving } = require('../services/halving');
const { calculateRate, MAX_SUPPLY } = require('../services/miningEngine');

module.exports = async function (fastify) {

  /// 🚀 START MINING
  fastify.post('/start', { preHandler: verifyToken }, async (req) => {

    /// 🔥 FIXED (support both JWT formats)
    const userId = req.user.userId || req.user.id;
    const ip = req.ip;

    const userRes = await db.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    const user = userRes.rows[0];

    if (!user) {
      return { error: "User not found" };
    }

    /// ❌ prevent multiple sessions
    if (user.is_mining) {
      return { error: "Already mining" };
    }

    /// ✅ start mining
    await db.query(`
      UPDATE users
      SET is_mining = true,
          last_mining_start = NOW(),
          last_ip = $1
      WHERE id = $2
    `, [ip, userId]);

    return { status: "started" };
  });


  /// ⏱ CHECK STATUS - PROTECTED ENDPOINT
  fastify.get('/status/:userId', { preHandler: verifyToken }, async (req, reply) => {

    const { userId } = req.params;
    const requestingUserId = req.user.userId || req.user.id;

    /// 🔐 USER OWNERSHIP CHECK - can only check own status
    if (String(requestingUserId) !== String(userId)) {
      reply.code(403);
      return { error: "Forbidden: Cannot check other user's status" };
    }

    const result = await db.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    const user = result.rows[0];

    if (!user || !user.is_mining) {
      return { isMining: false };
    }

    const now = new Date();
    const start = new Date(user.last_mining_start);

    const diffSeconds = Math.floor((now - start) / 1000);
    const remaining = Math.max(0, 21600 - diffSeconds);

    return {
      isMining: true,
      remainingSeconds: remaining,
    };
  });


  /// ✅ COMPLETE MINING
  fastify.post('/complete', { preHandler: verifyToken }, async (req) => {

    /// 🔥 FIXED (support both JWT formats)
    const userId = req.user.userId || req.user.id;

    const userRes = await db.query(
      `SELECT * FROM users WHERE id = $1`,
      [userId]
    );

    const user = userRes.rows[0];

    if (!user) {
      return { error: "User not found" };
    }

    const netRes = await db.query(`SELECT * FROM network_stats`);
    const stats = netRes.rows[0];

    /// ⏱ VALIDATE 6 HOURS
    const now = new Date();
    const diffHours =
      (now - new Date(user.last_mining_start)) / (1000 * 60 * 60);

    if (diffHours < 6) {
      return { error: "Mining not complete" };
    }

    /// 🚫 IF MINING ENDED
    if (!stats.is_mining_active) {
      return {
        reward: 0,
        message: "Network Mode: Mining ended. You now support the network."
      };
    }

    /// 🚫 MAX SUPPLY CHECK
    if (stats.total_mined >= MAX_SUPPLY) {
      await db.query(`
        UPDATE network_stats
        SET is_mining_active = FALSE
      `);

      return {
        reward: 0,
        message: "Max supply reached. Network Mode activated."
      };
    }

    /// 🔥 UPDATE HALVING
    const { halvingCount } = await updateHalving();

    /// 🔥 CALCULATE RATE
    const rate = calculateRate(halvingCount);

    let reward = rate * 6 * 60 * 60;

    /// 🔥 PREVENT OVER-MINT
    if (stats.total_mined + reward > MAX_SUPPLY) {
      reward = MAX_SUPPLY - stats.total_mined;

      await db.query(`
        UPDATE network_stats
        SET is_mining_active = FALSE
      `);
    }

    /// ✅ UPDATE USER
    await db.query(`
      UPDATE users
      SET balance = balance + $1,
          successful_sessions = successful_sessions + 1,
          is_mining = false
      WHERE id = $2
    `, [reward, userId]);

    /// ✅ UPDATE NETWORK
    await db.query(`
      UPDATE network_stats
      SET total_mined = total_mined + $1
    `, [reward]);

    return {
      reward,
      rate,
      message: stats.total_mined + reward >= MAX_SUPPLY
        ? "Final mining completed. Network Mode activated."
        : `Mining success | Halving Level: ${halvingCount}`
    };
  });

};