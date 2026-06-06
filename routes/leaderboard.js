const db = require('../db');

module.exports = async function (fastify) {

  /// 🏆 TOP USERS
  fastify.get('/top', async () => {
    const result = await db.query(`
      SELECT id, email, balance, successful_sessions
      FROM users
      ORDER BY balance DESC
      LIMIT 20
    `);

    return result.rows;
  });

  /// 👤 USER RANK
  fastify.get('/rank/:userId', async (req) => {
    const { userId } = req.params;

    const result = await db.query(`
      SELECT id,
             RANK() OVER (ORDER BY balance DESC) as rank,
             balance
      FROM users
    `);

    const user = result.rows.find(u => u.id == userId);

    return user || { error: "User not found" };
  });

};