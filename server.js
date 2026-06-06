// Compatibility launcher: if hosting still runs `node server.js`, start the real backend.
// Set USE_LEGACY_EXPRESS=true only if you intentionally want the old test server behavior.

if (String(process.env.USE_LEGACY_EXPRESS || 'false').toLowerCase() === 'true') {
  const express = require('express');
  const { Pool } = require('pg');

  const app = express();
  app.use(express.json());

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  app.get('/', (_req, res) => {
    res.json({ message: 'Legacy test server running' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'OK', mode: 'legacy' });
  });

  app.get('/db-test', async (_req, res) => {
    try {
      const result = await pool.query('SELECT NOW()');
      res.json({ success: true, time: result.rows[0].now });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  const port = process.env.PORT || 10000;
  app.listen(port, () => {
    console.log(`Legacy server running on port ${port}`);
  });
} else {
  require('./backend/server');
}
