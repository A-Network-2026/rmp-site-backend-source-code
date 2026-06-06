/**
 * 🧹 ACCOUNT CLEANUP & MAINTENANCE ROUTES
 * Handles inactivity cleanup and ecosystem management
 */

const { cleanupInactiveAccounts, getInactivityStats } = require('../services/inactivityCleanup');
const verifyToken = require('../middleware/auth');
const db = require('../db');

module.exports = async function (fastify) {
  
  /// 👨‍💼 ADMIN CHECK - Verify if user is admin (optional - can be enhanced with proper role system)
  async function isAdmin(userId) {
    // In production, implement proper role checking
    // For now, you can set admin user IDs or create an admin table
    const adminIds = process.env.ADMIN_USER_IDS?.split(',').map(id => parseInt(id)) || [1];
    return adminIds.includes(parseInt(userId));
  }

  /// 🧹 TRIGGER INACTIVITY CLEANUP (Admin only)
  fastify.post('/cleanup-inactive', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      
      // Check if user is admin
      if (!(await isAdmin(userId))) {
        return reply.code(403).send({ error: 'Admin access required' });
      }

      const result = await cleanupInactiveAccounts();
      
      return {
        message: 'Inactivity cleanup completed',
        ...result,
      };
    } catch (err) {
      console.error('Cleanup error:', err);
      return reply.code(500).send({ error: 'Cleanup failed', details: err.message });
    }
  });

  /// ♻️ RESET MINING STATE (Admin only, keeps user accounts)
  fastify.post('/reset-mining-state', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    let txStarted = false;
    try {
      const userId = req.user.userId;
      if (!(await isAdmin(userId))) {
        return reply.code(403).send({ error: 'Admin access required' });
      }

      await db.query('ALTER TABLE network_stats ADD COLUMN IF NOT EXISTS total_mined_ants NUMERIC(30,0) DEFAULT 0');
      await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS ant_balance NUMERIC(30,0) DEFAULT 0');

      await db.query('BEGIN');
      txStarted = true;
      await db.query(`
        UPDATE users
        SET balance = 0,
            ant_balance = 0,
            successful_sessions = 0,
            is_mining = FALSE,
            last_mining_start = NULL,
            updated_at = NOW()
      `);

      await db.query('TRUNCATE TABLE mining_sessions RESTART IDENTITY');

      await db.query(`
        UPDATE network_stats
        SET total_users = (SELECT COUNT(*)::int FROM users WHERE COALESCE(is_deleted, FALSE) = FALSE),
            eligible_users = 0,
            halving_count = 0,
            total_mined = 0,
            total_mined_ants = 0,
            is_mining_active = TRUE,
            updated_at = NOW()
      `);
      await db.query('COMMIT');
      txStarted = false;

      const statsRes = await db.readQuery(
        'SELECT total_users, eligible_users, halving_count, total_mined, total_mined_ants, is_mining_active FROM network_stats LIMIT 1'
      );

      return {
        message: 'Mining state reset completed. User accounts were kept.',
        network: statsRes.rows[0],
      };
    } catch (err) {
      if (txStarted) {
        await db.query('ROLLBACK');
      }
      console.error('Reset mining state error:', err);
      return reply.code(500).send({ error: 'Failed to reset mining state', details: err.message });
    }
  });

  /// 📊 GET INACTIVITY STATISTICS
  fastify.get('/inactivity-stats', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    try {
      const userId = req.user.userId;
      
      // Check if user is admin
      if (!(await isAdmin(userId))) {
        return reply.code(403).send({ error: 'Admin access required' });
      }

      const stats = await getInactivityStats();
      
      return {
        inactivityThresholdDays: 30,
        ...stats,
      };
    } catch (err) {
      console.error('Stats error:', err);
      return reply.code(500).send({ error: 'Failed to load stats', details: err.message });
    }
  });

  /// 💰 GET USER ANT BALANCE
  fastify.get('/ant-balance/:userId', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    try {
      const { userId: paramUserId } = req.params;
      const requesterId = req.user.userId;
      
      // Users can only view their own balance, admins can view anyone's
      const isRequestingOwn = parseInt(requesterId) === parseInt(paramUserId);
      const isAdminUser = await isAdmin(requesterId);
      
      if (!isRequestingOwn && !isAdminUser) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const result = await db.query(
        `SELECT id, email, ant_balance, custom_wallet_address, last_activity_at
         FROM users
         WHERE id = $1 AND is_deleted = FALSE`,
        [parseInt(paramUserId)]
      );

      const user = result.rows[0];
      if (!user) {
        return reply.code(404).send({ error: 'User not found' });
      }

      return {
        id: user.id,
        email: isAdminUser ? user.email : undefined, // Hide email from non-admins
        antBalance: Number(user.ant_balance || 0),
        customWallet: user.custom_wallet_address,
        lastActivity: user.last_activity_at,
      };
    } catch (err) {
      console.error('Balance error:', err);
      return reply.code(500).send({ error: 'Failed to load balance' });
    }
  });

  /// 📝 GET ANT TRANSACTION HISTORY
  fastify.get('/ant-transactions/:userId', {
    preHandler: verifyToken,
  }, async (req, reply) => {
    try {
      const { userId: paramUserId } = req.params;
      const requesterId = req.user.userId;
      const { limit = 100, offset = 0 } = req.query;
      
      // Users can only view their own transactions, admins can view anyone's
      const isRequestingOwn = parseInt(requesterId) === parseInt(paramUserId);
      const isAdminUser = await isAdmin(requesterId);
      
      if (!isRequestingOwn && !isAdminUser) {
        return reply.code(403).send({ error: 'Forbidden' });
      }

      const result = await db.query(
        `SELECT id, transaction_type, amount, from_address, to_address, description, status, created_at
         FROM ant_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [parseInt(paramUserId), Math.min(parseInt(limit), 1000), parseInt(offset)]
      );

      return {
        transactions: result.rows,
        count: result.rows.length,
      };
    } catch (err) {
      console.error('Transaction history error:', err);
      return reply.code(500).send({ error: 'Failed to load transaction history' });
    }
  });

};
