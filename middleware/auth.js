const jwt = require('jsonwebtoken');
require('dotenv').config();

const SECRET = process.env.JWT_SECRET;

async function verifyToken(req, reply) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      reply.code(401);
      return { error: "No token provided" };
    }

    /// Expect format: Bearer TOKEN
    const token = authHeader.split(" ")[1];

    if (!token) {
      reply.code(401);
      return { error: "Invalid token format" };
    }

    const decoded = jwt.verify(token, SECRET);

    /// validate token expiration
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      reply.code(401);
      return { error: "Token expired" };
    }

    /// attach user to request
    req.user = decoded;

  } catch (err) {
    reply.code(401);
    return { error: "Unauthorized" };
  }
}

module.exports = verifyToken;