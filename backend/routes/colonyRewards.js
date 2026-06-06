const db = require('../db');
const verifyToken = require('../middleware/auth');

const TOP_COLONIES_LIMIT = Math.max(
  1,
  Number(process.env.COLONY_TOP_REWARD_LIMIT || 10)
);
const DEFAULT_MONTHLY_POOL_USDT = Math.max(
  0,
  Number(process.env.COLONY_REWARD_POOL_USDT || 1000)
);
const COMMUNITY_ACTIVE_DAYS = Math.max(
  1,
  Number(process.env.COLONY_COMMUNITY_ACTIVE_DAYS || 30)
);
const DEFAULT_LEADERBOARD_LIMIT = Math.max(
  1,
  Number(process.env.COLONY_REWARD_LEADERBOARD_LIMIT || 50)
);
const ONCHAIN_TRANSPARENCY_RPC_URL = String(
  process.env.ANET_TRANSPARENCY_RPC_URL || ''
).trim();
const ONCHAIN_TRANSPARENCY_FROM_WALLET = String(
  process.env.ANET_TRANSPARENCY_FROM_WALLET || ''
).trim().toUpperCase();
const ONCHAIN_TRANSPARENCY_TO_WALLET = String(
  process.env.ANET_TRANSPARENCY_TO_WALLET || ''
).trim().toUpperCase();
const ONCHAIN_TRANSPARENCY_SENDER_SEED = String(
  process.env.ANET_TRANSPARENCY_SENDER_SEED || ''
).trim();
const ONCHAIN_TRANSPARENCY_AMOUNT_ANTS = Math.max(
  1,
  Number(process.env.ANET_TRANSPARENCY_AMOUNT_ANTS || 1)
);
const ONCHAIN_TRANSPARENCY_FEE_ANTS = Math.max(
  0,
  Number(process.env.ANET_TRANSPARENCY_FEE_ANTS || 1)
);
const FETCH_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.ANET_TRANSPARENCY_TIMEOUT_MS || 15000)
);
const RUN_COLONY_SCHEMA_SYNC_STARTUP = String(process.env.RUN_COLONY_SCHEMA_SYNC_STARTUP || 'false').trim().toLowerCase() === 'true';

let colonySchemaInitPromise = null;

function startColonySchemaSetup(fastify) {
  if (!colonySchemaInitPromise) {
    colonySchemaInitPromise = ensureSchema();

    if (fastify) {
      colonySchemaInitPromise
        .then(() => {
          fastify.log.info('Colony rewards startup schema checks completed');
        })
        .catch((err) => {
          fastify.log.error(err, 'Colony rewards startup schema checks failed');
        });
    }
  }

  return colonySchemaInitPromise;
}

module.exports = async function colonyRewardsRoutes(fastify) {
  if (RUN_COLONY_SCHEMA_SYNC_STARTUP) {
    await startColonySchemaSetup();
  } else {
    fastify.log.info('Colony rewards startup schema checks skipped (RUN_COLONY_SCHEMA_SYNC_STARTUP=false)');
  }

  fastify.get('/me', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = Number(req.user.userId || req.user.id);
      const cycleKey = normalizeCycleKey(req.query?.cycleKey) || currentCycleKey();
      const rewardPoolUsdt = parseRewardPool(req.query?.rewardPoolUsdt);
      const report = await buildCycleReport({ cycleKey, rewardPoolUsdt });
      const mine = report.rows.find((row) => row.ownerUserId === userId);

      if (!mine) {
        return reply.code(404).send({ error: 'User colony not found' });
      }

      return {
        model: 'colony-top10-active-v1',
        distributionAsset: 'USDT',
        issuanceAsset: 'view-only',
        referralModel: 'direct-only',
        rewardsEnabled: false,
        finalizationRequired: true,
        miningLinked: false,
        anetLinked: false,
        antsLinked: false,
        web3SettlementEnabled: false,
        onchainTransparencyAvailable: hasOnchainPublisherConfig(),
        cycle: report.cycle,
        formula: {
          ranking: `Top ${TOP_COLONIES_LIMIT} colonies are ranked by monthly active member count`,
          activeMembers: 'Only verified active referrals inside the monthly cycle are counted',
          rewards: 'Rewards remain manual. This route tracks transparency and ranking only.',
        },
        mine,
      };
    } catch (error) {
      console.error(error);
      return reply.code(500).send({ error: 'Failed to load colony reward preview' });
    }
  });

  fastify.get('/leaderboard', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const cycleKey = normalizeCycleKey(req.query?.cycleKey) || currentCycleKey();
      const rewardPoolUsdt = parseRewardPool(req.query?.rewardPoolUsdt);
      const limit = Math.max(
        1,
        Math.min(200, Number(req.query?.limit || DEFAULT_LEADERBOARD_LIMIT))
      );
      const report = await buildCycleReport({ cycleKey, rewardPoolUsdt });

      return {
        cycle: report.cycle,
        totalColonies: report.rows.length,
        rewardedColonies: report.rows.slice(0, TOP_COLONIES_LIMIT).length,
        leaderboard: report.rows.slice(0, limit),
      };
    } catch (error) {
      console.error(error);
      return reply.code(500).send({ error: 'Failed to load colony reward leaderboard' });
    }
  });

  fastify.get('/cycles/:cycleKey', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = Number(req.user.userId || req.user.id);
      const cycleKey = normalizeCycleKey(req.params?.cycleKey);
      if (!cycleKey) {
        return reply.code(400).send({ error: 'Invalid cycle key. Use YYYY-MM.' });
      }

      const report = await buildCycleReport({ cycleKey, rewardPoolUsdt: parseRewardPool(req.query?.rewardPoolUsdt) });
      const mine = report.rows.find((row) => row.ownerUserId === userId);

      return {
        cycle: report.cycle,
        mine: mine || null,
        finalized: report.cycle.status === 'finalized',
      };
    } catch (error) {
      console.error(error);
      return reply.code(500).send({ error: 'Failed to load colony reward cycle' });
    }
  });

  fastify.get('/admin/cycles', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const userId = Number(req.user.userId || req.user.id);
      if (!(await isAdmin(userId))) {
        return reply.code(403).send({ error: 'Admin access required' });
      }

      const rows = await db.query(
        `SELECT
           id,
           cycle_key,
           period_start,
           period_end,
           reward_pool_usdt,
           base_rate,
           network_active_users,
           total_network_cp,
           total_colonies,
           status,
           snapshot_taken_at,
           finalized_at,
           created_by_user_id,
           created_at,
           updated_at
         FROM colony_reward_cycles
         ORDER BY period_start DESC
         LIMIT 24`
      );

      return { cycles: rows.rows };
    } catch (error) {
      console.error(error);
      return reply.code(500).send({ error: 'Failed to load colony reward cycles' });
    }
  });

  fastify.post('/admin/finalize', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 8, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const userId = Number(req.user.userId || req.user.id);
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    const cycleKey = normalizeCycleKey(req.body?.cycleKey) || previousCycleKey();
    if (!cycleKey) {
      return reply.code(400).send({ error: 'Invalid cycle key. Use YYYY-MM.' });
    }

    const rewardPoolUsdt = parseRewardPool(req.body?.rewardPoolUsdt);
    const report = await buildCycleReport({ cycleKey, rewardPoolUsdt, useStoredCycle: false });
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      const upsertCycleRes = await client.query(
        `INSERT INTO colony_reward_cycles (
           cycle_key,
           period_start,
           period_end,
           reward_pool_usdt,
           base_rate,
           network_active_users,
           total_network_cp,
           total_colonies,
           status,
           snapshot_taken_at,
           finalized_at,
           created_by_user_id,
           formula_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalized', NOW(), NOW(), $9, $10)
         ON CONFLICT (cycle_key)
         DO UPDATE SET
           period_start = EXCLUDED.period_start,
           period_end = EXCLUDED.period_end,
           reward_pool_usdt = EXCLUDED.reward_pool_usdt,
           base_rate = EXCLUDED.base_rate,
           network_active_users = EXCLUDED.network_active_users,
           total_network_cp = EXCLUDED.total_network_cp,
           total_colonies = EXCLUDED.total_colonies,
           status = 'finalized',
           snapshot_taken_at = NOW(),
           finalized_at = NOW(),
           created_by_user_id = EXCLUDED.created_by_user_id,
           formula_version = EXCLUDED.formula_version,
           updated_at = NOW()
         RETURNING id`,
        [
          report.cycle.key,
          report.cycle.periodStart,
          report.cycle.periodEnd,
          report.cycle.rewardPoolUsdt,
          0,
          report.cycle.networkActiveUsers,
          report.cycle.totalTrackedActiveMembers,
          report.rows.length,
          userId,
          report.cycle.formulaVersion,
        ]
      );

      const cycleId = Number(upsertCycleRes.rows[0].id);
      await client.query('DELETE FROM colony_reward_allocations WHERE cycle_id = $1', [cycleId]);

      if (report.rows.length > 0) {
        const payload = JSON.stringify(
          report.rows.map((row) => ({
            owner_user_id: row.ownerUserId,
            colony_label: row.colonyLabel,
            invite_code: row.inviteCode,
            total_members: row.totalMembers,
            verified_members: row.verifiedMembers,
            active_members: row.activeMembers,
            community_participants: row.communityParticipants,
            total_messages: row.totalMessages,
            activity_rate: row.activityRate,
            colony_strength: 1,
            base_rate: 0,
            tier_name: row.rewardEligible ? 'Top 10' : 'Ranked',
            tier_multiplier: 1,
            base_cp: row.activeMembers,
            final_cp: row.activeMembers,
            reward_usdt: 0,
            status: 'finalized',
            metadata: {
              directOnly: true,
              viewOnly: true,
              formulaVersion: report.cycle.formulaVersion,
              rewardEligible: row.rewardEligible,
              rewardRank: row.rewardRank,
              verifiedMembers: row.verifiedMembers,
              activeMembers: row.activeMembers,
              communityParticipants: row.communityParticipants,
            },
          }))
        );

        await client.query(
          `INSERT INTO colony_reward_allocations (
             cycle_id,
             owner_user_id,
             colony_label,
             invite_code,
             total_members,
             verified_members,
             active_members,
             community_participants,
             total_messages,
             activity_rate,
             colony_strength,
             base_rate,
             tier_name,
             tier_multiplier,
             base_cp,
             final_cp,
             reward_usdt,
             status,
             metadata
           )
           SELECT
             $1,
             row.owner_user_id,
             row.colony_label,
             row.invite_code,
             row.total_members,
             row.verified_members,
             row.active_members,
             row.community_participants,
             row.total_messages,
             row.activity_rate,
             row.colony_strength,
             row.base_rate,
             row.tier_name,
             row.tier_multiplier,
             row.base_cp,
             row.final_cp,
             row.reward_usdt,
             row.status,
             row.metadata
           FROM jsonb_to_recordset($2::jsonb) AS row(
             owner_user_id bigint,
             colony_label text,
             invite_code text,
             total_members int,
             verified_members int,
             active_members int,
             community_participants int,
             total_messages bigint,
             activity_rate numeric,
             colony_strength numeric,
             base_rate numeric,
             tier_name text,
             tier_multiplier numeric,
             base_cp numeric,
             final_cp numeric,
             reward_usdt numeric,
             status text,
             metadata jsonb
           )`,
          [cycleId, payload]
        );
      }

      await client.query('COMMIT');

      return {
        message: `Colony reward cycle ${cycleKey} finalized`,
        cycle: report.cycle,
        totalColonies: report.rows.length,
        rewardedColonies: report.rows.slice(0, TOP_COLONIES_LIMIT),
        topColony: report.rows[0] || null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(error);
      return reply.code(500).send({ error: 'Failed to finalize colony reward cycle' });
    } finally {
      client.release();
    }
  });

  fastify.get('/cycles/:cycleKey/onchain', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const cycleKey = normalizeCycleKey(req.params?.cycleKey);
      if (!cycleKey) {
        return reply.code(400).send({ error: 'Invalid cycle key. Use YYYY-MM.' });
      }

      const anchors = await loadTransparencyAnchors(cycleKey);
      return {
        cycleKey,
        published: anchors.length > 0,
        count: anchors.length,
        anchors,
      };
    } catch (error) {
      console.error(error);
      return reply.code(500).send({ error: 'Failed to load onchain transparency records' });
    }
  });

  fastify.post('/admin/publish-onchain', {
    preHandler: verifyToken,
    config: { rateLimit: { max: 4, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const userId = Number(req.user.userId || req.user.id);
    if (!(await isAdmin(userId))) {
      return reply.code(403).send({ error: 'Admin access required' });
    }

    if (!hasOnchainPublisherConfig()) {
      return reply.code(400).send({
        error: 'Onchain transparency publisher is not configured',
        requiredEnv: [
          'ANET_TRANSPARENCY_RPC_URL',
          'ANET_TRANSPARENCY_FROM_WALLET',
          'ANET_TRANSPARENCY_TO_WALLET',
          'ANET_TRANSPARENCY_SENDER_SEED',
        ],
      });
    }

    const cycleKey = normalizeCycleKey(req.body?.cycleKey) || previousCycleKey();
    if (!cycleKey) {
      return reply.code(400).send({ error: 'Invalid cycle key. Use YYYY-MM.' });
    }

    const force = Boolean(req.body?.force);
    const storedCycle = await loadStoredCycle(cycleKey);
    if (!storedCycle || storedCycle.status !== 'finalized') {
      return reply.code(400).send({ error: 'Finalize the cycle before publishing onchain transparency' });
    }

    const existingAnchors = await loadTransparencyAnchors(cycleKey);
    if (existingAnchors.length > 0 && !force) {
      return reply.code(409).send({
        error: 'Onchain transparency already published for this cycle',
        cycleKey,
        anchors: existingAnchors,
      });
    }

    const report = await buildCycleReport({
      cycleKey,
      rewardPoolUsdt: parseRewardPool(req.body?.rewardPoolUsdt),
      useStoredCycle: true,
    });

    try {
      const publishedAnchors = await publishTransparencyAnchors({
        cycleId: Number(storedCycle.id),
        cycleKey,
        report,
        publishedByUserId: userId,
        replaceExisting: force,
      });

      return {
        message: `Published Top ${publishedAnchors.length} colony transparency anchors onchain`,
        cycleKey,
        published: publishedAnchors,
      };
    } catch (error) {
      console.error(error);
      return reply.code(500).send({ error: error.message || 'Failed to publish onchain transparency' });
    }
  });
};

async function ensureSchema() {
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE');

  await db.query(`
    CREATE TABLE IF NOT EXISTS colony_reward_cycles (
      id BIGSERIAL PRIMARY KEY,
      cycle_key VARCHAR(7) NOT NULL UNIQUE,
      period_start TIMESTAMP NOT NULL,
      period_end TIMESTAMP NOT NULL,
      reward_pool_usdt DECIMAL(20, 8) NOT NULL DEFAULT 1000,
      base_rate DECIMAL(20, 8) NOT NULL DEFAULT 0.0015,
      network_active_users BIGINT NOT NULL DEFAULT 0,
      total_network_cp DECIMAL(30, 8) NOT NULL DEFAULT 0,
      total_colonies BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      formula_version VARCHAR(32) NOT NULL DEFAULT 'f1-v1',
      snapshot_taken_at TIMESTAMP,
      finalized_at TIMESTAMP,
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS colony_reward_allocations (
      id BIGSERIAL PRIMARY KEY,
      cycle_id BIGINT NOT NULL REFERENCES colony_reward_cycles(id) ON DELETE CASCADE,
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      colony_label VARCHAR(255),
      invite_code VARCHAR(32),
      total_members INT NOT NULL DEFAULT 0,
      verified_members INT NOT NULL DEFAULT 0,
      active_members INT NOT NULL DEFAULT 0,
      community_participants INT NOT NULL DEFAULT 0,
      total_messages BIGINT NOT NULL DEFAULT 0,
      activity_rate DECIMAL(20, 8) NOT NULL DEFAULT 0,
      colony_strength DECIMAL(20, 8) NOT NULL DEFAULT 1,
      base_rate DECIMAL(20, 8) NOT NULL DEFAULT 0.0015,
      tier_name VARCHAR(32) NOT NULL DEFAULT 'Tier 1',
      tier_multiplier DECIMAL(20, 8) NOT NULL DEFAULT 1,
      base_cp DECIMAL(30, 8) NOT NULL DEFAULT 0,
      final_cp DECIMAL(30, 8) NOT NULL DEFAULT 0,
      reward_usdt DECIMAL(20, 8) NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'finalized',
      metadata JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cycle_id, owner_user_id)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS colony_reward_transparency_anchors (
      id BIGSERIAL PRIMARY KEY,
      cycle_id BIGINT NOT NULL REFERENCES colony_reward_cycles(id) ON DELETE CASCADE,
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rank_position INT NOT NULL,
      colony_label VARCHAR(255) NOT NULL,
      top_owner_label VARCHAR(255) NOT NULL DEFAULT '',
      invite_code VARCHAR(32),
      active_members INT NOT NULL DEFAULT 0,
      anet_transaction_id VARCHAR(128) NOT NULL,
      memo VARCHAR(160) NOT NULL,
      publish_status VARCHAR(32) NOT NULL DEFAULT 'accepted',
      published_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (cycle_id, rank_position)
    )
  `);

  await db.query('ALTER TABLE colony_reward_allocations ADD COLUMN IF NOT EXISTS verified_members INT NOT NULL DEFAULT 0');
  await db.query('ALTER TABLE colony_reward_allocations ADD COLUMN IF NOT EXISTS community_participants INT NOT NULL DEFAULT 0');
  await db.query('ALTER TABLE colony_reward_allocations ADD COLUMN IF NOT EXISTS total_messages BIGINT NOT NULL DEFAULT 0');
  await db.query("ALTER TABLE colony_reward_transparency_anchors ADD COLUMN IF NOT EXISTS top_owner_label VARCHAR(255) NOT NULL DEFAULT ''");

  await db.query('CREATE INDEX IF NOT EXISTS idx_colony_reward_cycles_status ON colony_reward_cycles(status)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_colony_reward_cycles_period_start ON colony_reward_cycles(period_start DESC)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_colony_reward_allocations_cycle ON colony_reward_allocations(cycle_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_colony_reward_allocations_owner ON colony_reward_allocations(owner_user_id)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_colony_reward_transparency_cycle ON colony_reward_transparency_anchors(cycle_id, rank_position ASC)');
}

async function buildCycleReport({ cycleKey, rewardPoolUsdt, useStoredCycle = true }) {
  const cycle = cycleBounds(cycleKey);
  const [ownerMetrics, networkActiveUsers, storedCycle, storedAllocations, storedAnchors] = await Promise.all([
    loadOwnerMetrics(cycle.periodStart, cycle.periodEnd),
    loadNetworkActiveUsers(cycle.periodStart, cycle.periodEnd),
    loadStoredCycle(cycle.key),
    loadStoredAllocations(cycle.key),
    loadTransparencyAnchors(cycle.key),
  ]);

  const pool = useStoredCycle && storedCycle?.reward_pool_usdt != null
    ? Number(storedCycle.reward_pool_usdt)
    : rewardPoolUsdt;

  const rows = ownerMetrics.map((row) => {
    const totalMembers = Number(row.total_members || 0);
    const activeMembers = Number(row.active_members || 0);
    const verifiedMembers = Number(row.verified_members || 0);
    const communityParticipants = Number(row.community_participants || 0);
    const totalMessages = Number(row.total_messages || 0);
    const activityRate = totalMembers > 0 ? activeMembers / totalMembers : 0;

    return {
      ownerUserId: Number(row.owner_user_id),
      colonyLabel: String(row.colony_label || `User ${row.owner_user_id}`).trim(),
      ownerLabel: String(row.colony_label || `User ${row.owner_user_id}`).trim(),
      inviteCode: String(row.invite_code || '').trim(),
      totalMembers,
      verifiedMembers,
      activeMembers,
      communityParticipants,
      totalMessages,
      activityRate: roundTo(activityRate),
      estimatedRewardUsdt: 0,
      finalizedRewardUsdt: 0,
      finalized: false,
    };
  });

  const allocationMap = new Map(
    storedAllocations.map((row) => [Number(row.owner_user_id), row])
  );
  const anchorMap = new Map(
    storedAnchors.map((row) => [Number(row.owner_user_id), row])
  );

  const ranked = rows
    .map((row) => {
      const allocation = allocationMap.get(row.ownerUserId);
      const anchor = anchorMap.get(row.ownerUserId);
      return {
        ...row,
        estimatedRewardUsdt: 0,
        finalizedRewardUsdt: allocation ? Number(allocation.reward_usdt || 0) : null,
        finalized: Boolean(allocation),
        onchainAnchor: anchor || null,
      };
    })
    .sort((left, right) => {
      if (right.activeMembers !== left.activeMembers) return right.activeMembers - left.activeMembers;
      if (right.verifiedMembers !== left.verifiedMembers) return right.verifiedMembers - left.verifiedMembers;
      if (right.totalMembers !== left.totalMembers) return right.totalMembers - left.totalMembers;
      return left.ownerUserId - right.ownerUserId;
    })
    .map((row, index) => {
      const rank = index + 1;
      return {
        ...row,
        rank,
        rewardEligible: rank <= TOP_COLONIES_LIMIT,
        rewardRank: rank <= TOP_COLONIES_LIMIT ? rank : null,
      };
    });

  const totalTrackedActiveMembers = ranked.reduce((sum, row) => sum + row.activeMembers, 0);

  return {
    cycle: {
      key: cycle.key,
      periodStart: cycle.periodStart,
      periodEnd: cycle.periodEnd,
      rewardPoolUsdt: roundTo(pool),
      networkActiveUsers,
      totalTrackedActiveMembers,
      rewardedColoniesLimit: TOP_COLONIES_LIMIT,
      onchainPublished: storedAnchors.length > 0,
      onchainAnchorCount: storedAnchors.length,
      status: storedCycle?.status || 'preview',
      formulaVersion: storedCycle?.formula_version || 'top10-active-v1',
      finalizedAt: storedCycle?.finalized_at || null,
    },
    rows: ranked,
  };
}

async function loadOwnerMetrics(periodStart, periodEnd) {
  const result = await db.query(
    `WITH recent_members AS (
       SELECT
         ref.id,
         ref.referred_by,
         COALESCE(ref.email_verified, FALSE) AS email_verified,
         CASE
           WHEN COALESCE(ref.last_activity_at, ref.last_seen_at, ref.updated_at, ref.created_at) >= $3 THEN TRUE
           ELSE FALSE
         END AS is_active
       FROM users ref
       WHERE COALESCE(ref.is_deleted, FALSE) = FALSE
         AND COALESCE(ref.is_banned, FALSE) = FALSE
         AND COALESCE(ref.is_flagged, FALSE) = FALSE
     ),
     cycle_messages AS (
       SELECT
         room.owner_user_id,
         COUNT(msg.id)::bigint AS total_messages,
         COUNT(DISTINCT msg.user_id)::int AS community_participants
       FROM referral_chat_rooms room
       LEFT JOIN referral_group_messages msg
         ON msg.room_key = room.room_key
        AND msg.created_at >= $1
        AND msg.created_at < $2
       GROUP BY room.owner_user_id
     ),
     referral_rollup AS (
       SELECT
         owner.id AS owner_user_id,
         COUNT(member.id)::int AS total_members,
         COUNT(*) FILTER (
           WHERE member.id IS NOT NULL
             AND member.email_verified = TRUE
         )::int AS verified_members,
         COUNT(*) FILTER (
           WHERE member.id IS NOT NULL
             AND member.is_active = TRUE
         )::int AS active_members
       FROM users owner
       LEFT JOIN recent_members member ON member.referred_by = owner.id
       WHERE COALESCE(owner.is_deleted, FALSE) = FALSE
       GROUP BY owner.id
     )
     SELECT
       owner.id AS owner_user_id,
       COALESCE(NULLIF(owner.referral_code, ''), SPLIT_PART(owner.email, '@', 1), 'User ' || owner.id::text) AS colony_label,
       COALESCE(owner.referral_code, '') AS invite_code,
       COALESCE(rollup.total_members, 0)::int AS total_members,
       COALESCE(rollup.verified_members, 0)::int AS verified_members,
       COALESCE(rollup.active_members, 0)::int AS active_members,
       COALESCE(messages.community_participants, 0)::int AS community_participants,
       COALESCE(messages.total_messages, 0)::bigint AS total_messages
     FROM users owner
     LEFT JOIN referral_rollup rollup ON rollup.owner_user_id = owner.id
     LEFT JOIN cycle_messages messages ON messages.owner_user_id = owner.id
     WHERE COALESCE(owner.is_deleted, FALSE) = FALSE
     ORDER BY owner.id ASC`,
    [periodStart, periodEnd, activityThreshold(periodEnd)]
  );

  return result.rows;
}

async function loadNetworkActiveUsers(periodStart, periodEnd) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS active_users
     FROM users u
     WHERE COALESCE(u.email_verified, FALSE) = TRUE
       AND COALESCE(u.is_deleted, FALSE) = FALSE
       AND COALESCE(u.is_banned, FALSE) = FALSE
       AND COALESCE(u.is_flagged, FALSE) = FALSE
       AND COALESCE(u.last_activity_at, u.last_seen_at, u.updated_at, u.created_at) >= $1`,
    [activityThreshold(periodEnd)]
  );
  return Number(result.rows[0]?.active_users || 0);
}

async function loadStoredCycle(cycleKey) {
  const result = await db.query(
    `SELECT *
     FROM colony_reward_cycles
     WHERE cycle_key = $1
     LIMIT 1`,
    [cycleKey]
  );
  return result.rows[0] || null;
}

async function loadStoredAllocations(cycleKey) {
  const result = await db.query(
    `SELECT alloc.*
     FROM colony_reward_allocations alloc
     JOIN colony_reward_cycles cycle ON cycle.id = alloc.cycle_id
     WHERE cycle.cycle_key = $1`,
    [cycleKey]
  );
  return result.rows;
}

async function loadTransparencyAnchors(cycleKey) {
  const result = await db.query(
    `SELECT
       anchor.id,
       anchor.owner_user_id,
       anchor.rank_position,
       anchor.colony_label,
       anchor.top_owner_label,
       anchor.invite_code,
       anchor.active_members,
       anchor.anet_transaction_id,
       anchor.memo,
       anchor.publish_status,
       anchor.created_at
     FROM colony_reward_transparency_anchors anchor
     JOIN colony_reward_cycles cycle ON cycle.id = anchor.cycle_id
     WHERE cycle.cycle_key = $1
     ORDER BY anchor.rank_position ASC`,
    [cycleKey]
  );
  return result.rows;
}

function hasOnchainPublisherConfig() {
  return Boolean(
    ONCHAIN_TRANSPARENCY_RPC_URL &&
    ONCHAIN_TRANSPARENCY_FROM_WALLET &&
    ONCHAIN_TRANSPARENCY_TO_WALLET &&
    ONCHAIN_TRANSPARENCY_SENDER_SEED
  );
}

async function publishTransparencyAnchors({ cycleId, cycleKey, report, publishedByUserId, replaceExisting }) {
  const topRows = report.rows.slice(0, TOP_COLONIES_LIMIT);
  if (topRows.length === 0) {
    return [];
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (replaceExisting) {
      await client.query('DELETE FROM colony_reward_transparency_anchors WHERE cycle_id = $1', [cycleId]);
    }

    const published = [];
    for (const row of topRows) {
      const memo = buildAnchorMemo(cycleKey, row);
      const chainResult = await submitTransparencyTransaction(memo);
      const insertRes = await client.query(
        `INSERT INTO colony_reward_transparency_anchors (
           cycle_id,
           owner_user_id,
           rank_position,
           colony_label,
            top_owner_label,
           invite_code,
           active_members,
           anet_transaction_id,
           memo,
           publish_status,
           published_by_user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, created_at`,
        [
          cycleId,
          row.ownerUserId,
          row.rank,
          row.colonyLabel,
          row.ownerLabel,
          row.inviteCode,
          row.activeMembers,
          chainResult.transaction_id,
          memo,
          chainResult.status || 'accepted',
          publishedByUserId,
        ]
      );

      published.push({
        id: insertRes.rows[0].id,
        createdAt: insertRes.rows[0].created_at,
        rank: row.rank,
        ownerUserId: row.ownerUserId,
        colonyLabel: row.colonyLabel,
        topOwnerLabel: row.ownerLabel,
        activeMembers: row.activeMembers,
        anetTransactionId: chainResult.transaction_id,
        status: chainResult.status || 'accepted',
        memo,
      });
    }

    await client.query('COMMIT');
    return published;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function buildAnchorMemo(cycleKey, row) {
  const compactLabel = String(row.colonyLabel || '')
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
  const compactOwner = String(row.ownerLabel || row.colonyLabel || '')
    .replace(/[^a-zA-Z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
  return `COLONYTOP10|${cycleKey}|#${row.rank}|${compactLabel}|owner=${compactOwner}|active=${row.activeMembers}`
    .slice(0, 160);
}

async function submitTransparencyTransaction(memo) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable in this Node runtime');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${ONCHAIN_TRANSPARENCY_RPC_URL.replace(/\/$/, '')}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: ONCHAIN_TRANSPARENCY_FROM_WALLET,
        to: ONCHAIN_TRANSPARENCY_TO_WALLET,
        amount_ants: ONCHAIN_TRANSPARENCY_AMOUNT_ANTS,
        fee_ants: ONCHAIN_TRANSPARENCY_FEE_ANTS,
        memo,
        sender_seed: ONCHAIN_TRANSPARENCY_SENDER_SEED,
      }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `ANET transparency submission failed with ${response.status}`);
    }

    if (!payload.transaction_id) {
      throw new Error('ANET transparency submission did not return a transaction_id');
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function parseRewardPool(value) {
  if (value == null || value === '') {
    return roundTo(DEFAULT_MONTHLY_POOL_USDT);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return roundTo(DEFAULT_MONTHLY_POOL_USDT);
  }
  return roundTo(parsed);
}

function roundTo(value, precision = 8) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(precision));
}

function normalizeCycleKey(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : '';
}

function currentCycleKey(now = new Date()) {
  return cycleKeyForDate(now);
}

function previousCycleKey(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return cycleKeyForDate(new Date(Date.UTC(year, month - 1, 1)));
}

function cycleKeyForDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function cycleBounds(cycleKey) {
  const [yearText, monthText] = cycleKey.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const periodStart = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0));
  return { key: cycleKey, periodStart, periodEnd };
}

async function isAdmin(userId) {
  const adminIds = String(process.env.ADMIN_USER_IDS || '1')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  return adminIds.includes(Number(userId));
}

function activityThreshold(cycleEnd) {
  const end = new Date(cycleEnd);
  return new Date(end.getTime() - (COMMUNITY_ACTIVE_DAYS * 24 * 60 * 60 * 1000));
}