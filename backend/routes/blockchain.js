// Public blockchain transparency endpoints.
const { randomBytes } = require('crypto');
const db = require('../db');
const readQuery = typeof db.readQuery === 'function' ? db.readQuery : db.query;

// Simulate a testnet blockchain in-memory (for demo)
let blocks = [];
let sessions = new Set();
let miners = new Set();

function randomMiner() {
  const names = ['ant1','ant2','ant3','ant4','ant5','ant6','ant7','ant8','ant9','ant10'];
  return names[Math.floor(Math.random() * names.length)];
}

function randomSession() {
  return 'S' + Math.floor(Math.random() * 1000 + 1);
}

function createBlock() {
  const hash = randomBytes(8).toString('hex');
  const session = randomSession();
  const miner = randomMiner();
  const timestamp = new Date().toISOString().replace('T',' ').slice(0,19);
  sessions.add(session);
  miners.add(miner);
  return { hash, session, miner, timestamp };
}

// Populate with some blocks
for (let i = 0; i < 20; ++i) blocks.push(createBlock());

// Add a new block every 10 seconds (simulate mining)
setInterval(() => {
  blocks.unshift(createBlock());
  if (blocks.length > 50) blocks.pop();
  // Rebuild sets from current blocks to prevent unbounded memory growth.
  sessions = new Set(blocks.map(b => b.session));
  miners = new Set(blocks.map(b => b.miner));
}, 10000);

async function buildTransparencyPayload() {
  const [networkRes, userRes, claimsRes] = await Promise.all([
    readQuery(`
      SELECT total_mined_ants, total_anet_distributed, is_mining_active, halving_count, updated_at
      FROM network_stats
      ORDER BY id ASC
      LIMIT 1
    `),
    readQuery(`
      SELECT
        COUNT(*)::bigint AS total_registered_accounts,
        COUNT(*) FILTER (
          WHERE COALESCE(is_deleted, FALSE) = FALSE
            AND COALESCE(email_verified, FALSE) = TRUE
            AND COALESCE(successful_sessions, 0) >= 1000
        )::bigint AS total_eligible_accounts,
        COUNT(*) FILTER (
          WHERE COALESCE(is_deleted, FALSE) = FALSE
            AND COALESCE(claimed_anet, 0) > 0
        )::bigint AS total_claimed_accounts
      FROM users
    `),
    readQuery(`
      SELECT
        COUNT(*)::bigint AS total_claim_transactions,
        COALESCE(SUM(amount), 0)::numeric AS total_claim_amount
      FROM ant_transactions
      WHERE transaction_type = 'mining_claim'
        AND COALESCE(status, 'pending') = 'completed'
    `),
  ]);

  const network = networkRes.rows[0] || {};
  const users = userRes.rows[0] || {};
  const claims = claimsRes.rows[0] || {};

  return {
    mode: 'production_transparency',
    source: 'backend_database',
    chainFinality: 'not_reported_by_this_endpoint',
    note: 'This endpoint exposes backend-side economic totals for community transparency. It is not a substitute for independent on-chain verification.',
    totals: {
      totalRegisteredAccounts: Number(users.total_registered_accounts || 0),
      totalEligibleAccounts: Number(users.total_eligible_accounts || 0),
      totalClaimedAccounts: Number(users.total_claimed_accounts || 0),
      totalMinedAnts: Number(network.total_mined_ants || 0),
      totalAnetDistributed: Number(network.total_anet_distributed || 0),
      totalClaimTransactions: Number(claims.total_claim_transactions || 0),
      totalClaimAmount: Number(claims.total_claim_amount || 0),
      halvingStage: Number(network.halving_count || 0),
      isMiningActive: Boolean(network.is_mining_active),
    },
    updatedAt: network.updated_at || null,
  };
}

module.exports = async function(fastify) {
  fastify.get('/testnet', async (req, reply) => {
    reply.send({
      mode: 'demo_testnet',
      demoData: true,
      note: 'Demo-only public preview data for community transparency. This endpoint does not represent live settlement or production chain finality.',
      totalBlocks: blocks.length,
      totalSessions: sessions.size,
      activeMiners: miners.size,
      blocks: blocks.slice(0, 20)
    });
  });

  const sendTransparency = async (req, reply) => {
    try {
      reply.header('Cache-Control', 'public, max-age=30');
      return reply.send(await buildTransparencyPayload());
    } catch (err) {
      req.log.error(err, 'Failed to build blockchain transparency payload');
      return reply.code(500).send({ error: 'Failed to load transparency data' });
    }
  };

  fastify.get('/final', sendTransparency);
  fastify.get('/transparency', sendTransparency);
};
