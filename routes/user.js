const db = require('../db');
const { v4: uuidv4 } = require('uuid');

module.exports = async function (fastify) {

  fastify.post('/create', async () => {
    const uuid = uuidv4();

    const result = await db.query(`
      INSERT INTO users (uuid)
      VALUES ($1)
      RETURNING *
    `, [uuid]);

    return result.rows[0];
  });

};