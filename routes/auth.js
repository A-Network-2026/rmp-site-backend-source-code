const db = require('../db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const SECRET = process.env.JWT_SECRET;

module.exports = async function (fastify) {

  /// 🔐 REGISTER
  fastify.post('/register', async (req) => {
    try {
      const { email, password, deviceId } = req.body;

      /// check if user exists
      const existing = await db.query(
        `SELECT * FROM users WHERE email = $1`,
        [email]
      );

      if (existing.rows.length > 0) {
        return { error: "User already exists" };
      }

      /// hash password
      const hashed = await bcrypt.hash(password, 10);

      const result = await db.query(`
        INSERT INTO users (email, password, device_id)
        VALUES ($1, $2, $3)
        RETURNING id, email
      `, [email, hashed, deviceId]);

      const user = result.rows[0];

      /// create token
      const token = jwt.sign(
        { userId: user.id },
        SECRET,
        { expiresIn: "7d" }
      );

      return {
        message: "Registered successfully",
        token,
        user
      };

    } catch (err) {
      console.error(err);
      return { error: "Registration failed" };
    }
  });


  /// 🔐 LOGIN
  fastify.post('/login', async (req) => {
    try {
      const { email, password } = req.body;

      const result = await db.query(
        `SELECT * FROM users WHERE email = $1`,
        [email]
      );

      const user = result.rows[0];

      if (!user) {
        return { error: "User not found" };
      }

      const valid = await bcrypt.compare(password, user.password);

      if (!valid) {
        return { error: "Invalid password" };
      }

      const token = jwt.sign(
        { userId: user.id },
        SECRET,
        { expiresIn: "7d" }
      );

      return {
        message: "Login successful",
        token,
        user: {
          id: user.id,
          email: user.email
        }
      };

    } catch (err) {
      console.error(err);
      return { error: "Login failed" };
    }
  });

};