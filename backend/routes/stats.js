const db = require('../db');
const https = require('https');
const {
  MAX_SUPPLY,
  MAX_SUPPLY_ANTS,
  ANTS_PER_ANET,
  buildGlobalState,
} = require('../services/miningEngine');

const ANET_CONTRACT = (process.env.ANET_CONTRACT || '0x791055A7d52AA392eaE8De04250497f33807E46A').toLowerCase();
const BSC_SCAN_API = process.env.BSCSCAN_API_URL || 'https://api.etherscan.io/v2/api';
const BSC_SCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const BSC_SCAN_CHAIN_ID = String(process.env.BSCSCAN_CHAIN_ID || '56');
const ANET_DECIMALS = Number(process.env.ANET_DECIMALS || 18);
const RUN_STATS_SCHEMA_SYNC_STARTUP = String(process.env.RUN_STATS_SCHEMA_SYNC_STARTUP || 'false').trim().toLowerCase() === 'true';
const NETWORK_STATS_CACHE_MS = Math.max(1000, Number(process.env.NETWORK_STATS_CACHE_MS || 30000));
const COUNTRY_STATS_CACHE_MS = Math.max(2000, Number(process.env.COUNTRY_STATS_CACHE_MS || 60000));
const STATS_USE_PRECOMPUTED = String(process.env.STATS_USE_PRECOMPUTED || 'true').trim().toLowerCase() === 'true';
const STATS_PRECOMPUTE_TARGET_AGE_MS = Math.max(5000, Number(process.env.STATS_PRECOMPUTE_TARGET_AGE_MS || 30000));
const STATS_PRECOMPUTE_MAX_STALE_MS = Math.max(STATS_PRECOMPUTE_TARGET_AGE_MS, Number(process.env.STATS_PRECOMPUTE_MAX_STALE_MS || 15 * 60 * 1000));

let networkStatsCache = { expiresAt: 0, payload: null };
let networkStatsInflight = null;
let countryStatsCache = { expiresAt: 0, payload: null };
let countryStatsInflight = null;
let networkSnapshotRefreshInflight = null;
let countrySnapshotRefreshInflight = null;

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function resolveEvmChainId(network) {
  const normalized = String(network || '').trim().toLowerCase();
  if (!normalized || normalized === 'bnb smart chain' || normalized === 'bsc') {
    return '56';
  }
  if (normalized === 'ethereum' || normalized === 'eth') {
    return '1';
  }
  if (normalized === 'polygon' || normalized === 'matic') {
    return '137';
  }
  return null;
}

function formatUnits(raw, decimals) {
  try {
    const base = BigInt(10) ** BigInt(decimals);
    const amount = BigInt(raw);
    const whole = amount / base;
    const fraction = amount % base;
    if (fraction === 0n) {
      return whole.toString();
    }

    let fracText = fraction.toString().padStart(decimals, '0');
    fracText = fracText.replace(/0+$/, '');
    return `${whole.toString()}.${fracText}`;
  } catch (_) {
    return '0';
  }
}

function formatInteger(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return '0';
  }

  return Math.round(numeric).toLocaleString('en-US');
}

async function callBscScan(params) {
  const url = new URL(BSC_SCAN_API);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  if (url.pathname.includes('/v2/api') && !url.searchParams.has('chainid')) {
    url.searchParams.set('chainid', BSC_SCAN_CHAIN_ID);
  }
  if (BSC_SCAN_API_KEY) {
    url.searchParams.set('apikey', BSC_SCAN_API_KEY);
  }

  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`BscScan HTTP ${res.statusCode}`));
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function ensureCountrySchema() {
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS country VARCHAR(80) DEFAULT 'Unknown'
  `);
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE
  `);
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE
  `);
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_mining_start TIMESTAMP NULL
  `);
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS session_end_time TIMESTAMP NULL
  `);
  await db.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP NULL
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS stats_network_snapshot (
      id SMALLINT PRIMARY KEY,
      payload JSONB NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS stats_country_snapshot (
      id SMALLINT PRIMARY KEY,
      payload JSONB NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

module.exports = async function (fastify) {
  const readQuery = typeof db.readQuery === 'function' ? db.readQuery : db.query;
  const writeQuery = typeof db.writeQuery === 'function' ? db.writeQuery : db.query;

  if (RUN_STATS_SCHEMA_SYNC_STARTUP) {
    await ensureCountrySchema();
  } else {
    fastify.log.info('Stats startup schema checks skipped (RUN_STATS_SCHEMA_SYNC_STARTUP=false)');
  }

  // Always refresh the network snapshot on startup so stale/zero snapshots
  // never survive a redeploy. Runs in background — does not block server start.
  loadNetworkStatsFresh()
    .then((payload) => {
      networkStatsCache = { payload, expiresAt: Date.now() + NETWORK_STATS_CACHE_MS };
      return writeQuery(
        `INSERT INTO stats_network_snapshot (id, payload, computed_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at`,
        [JSON.stringify(payload)]
      );
    })
    .then(() => {
      fastify.log.info('Network stats snapshot refreshed on startup');
    })
    .catch((err) => {
      fastify.log.warn(err, 'Startup network stats snapshot refresh failed (non-fatal)');
    });

  async function loadNetworkStatsFresh() {
    // NOTE: `total_sessions` MUST be aggregated identically to
    // services/halving.js → computeHalvingSnapshot(), because the chain's
    // credit logic (routes/mining.js → calculateRewardAnts) reads from that
    // same source. If the two disagree across the LEGACY_LAUNCH_SESSIONS
    // (500K) boundary, the user-visible "Current Rate" drifts from what
    // their next session will actually pay. Keep these SUMs in sync.
    const userAggRes = await readQuery(`
      SELECT
        COUNT(*) FILTER (
          WHERE COALESCE(email_verified, FALSE) = TRUE
            AND COALESCE(successful_sessions, 0) > 0
        )::bigint AS total_users,
        COUNT(*) FILTER (
          WHERE COALESCE(email_verified, FALSE) = TRUE
            AND COALESCE(successful_sessions, 0) > 0
            AND COALESCE(last_seen_at, NOW() - INTERVAL '100 years') > NOW() - INTERVAL '5 minutes'
        )::bigint AS users_online,
        COUNT(*) FILTER (
          WHERE COALESCE(email_verified, FALSE) = TRUE
            AND COALESCE(is_mining, FALSE) = TRUE
            AND COALESCE(session_end_time, NOW() - INTERVAL '1 second') > NOW()
            AND COALESCE(last_mining_start, NOW() - INTERVAL '100 years') > NOW() - INTERVAL '8 hours'
        )::bigint AS total_active_miners,
        COUNT(*) FILTER (
          WHERE COALESCE(email_verified, FALSE) = TRUE
            AND COALESCE(successful_sessions, 0) >= 1000
        )::bigint AS total_eligible_users,
        COUNT(*) FILTER (
          WHERE COALESCE(email_verified, FALSE) = TRUE
            AND COALESCE(claimed_anet, 0) > 0
        )::bigint AS total_converted_users,
        -- Must match halving.js::computeHalvingSnapshot exactly:
        -- SUM(successful_sessions) over all non-deleted users (no
        -- email_verified gate). Otherwise display "Current Rate" desyncs
        -- from the rate the credit path actually uses at session payout.
        COALESCE(SUM(COALESCE(successful_sessions, 0)), 0)::bigint AS total_sessions
      FROM users
      WHERE COALESCE(is_deleted, FALSE) = FALSE
    `);

    const registeredRes = await readQuery(`
      SELECT COUNT(*)::bigint AS total_registered FROM users
    `);

    const netRes = await readQuery(`
      SELECT total_mined_ants, total_anet_distributed, is_mining_active, halving_count
      FROM network_stats
      LIMIT 1
    `);

    const realMinersRes = await readQuery(`
      SELECT COUNT(DISTINCT user_id)::bigint AS total_real_miners
      FROM mining_sessions
      WHERE is_completed = TRUE AND (status IS NULL OR status = 'completed')
    `);

    const users = userAggRes.rows[0] || {};
    const stats = netRes.rows[0] || {};
    const realMiners = realMinersRes.rows[0] || {};
    const registered = registeredRes.rows[0] || {};

    return buildGlobalState({
      totalRegisteredAccounts: Number(registered.total_registered || 0),
      totalRealMiners: Number(realMiners.total_real_miners || 0),
      totalUsers: Number(users.total_users || 0),
      usersOnline: Number(users.users_online || 0),
      totalSessions: Number(users.total_sessions || 0),
      totalCompletedSessions: Number(users.total_sessions || 0),
      totalActiveMiners: Number(users.total_active_miners || 0),
      totalEligibleUsers: Number(users.total_eligible_users || 0),
      totalConvertedUsers: Number(users.total_converted_users || 0),
      totalANTSAccumulated: Number(stats.total_mined_ants || 0),
      totalANETClaimed: Number(stats.total_anet_distributed || 0),
      halvingStage: Number(stats.halving_count || 0),
      isMiningActive: Boolean(stats.is_mining_active),
      presenceWindowMinutes: 5,
    });
  }

  async function loadCountryStatsFresh() {
    const rows = await readQuery(`
      SELECT COALESCE(NULLIF(TRIM(country), ''), 'Unknown') AS country,
             COUNT(*)::int AS users
      FROM users
      WHERE COALESCE(is_deleted, FALSE) = FALSE
        AND COALESCE(email_verified, FALSE) = TRUE
      GROUP BY 1
      ORDER BY users DESC, country ASC
    `);

    const totalUsers = rows.rows.reduce((acc, row) => acc + Number(row.users || 0), 0);
    return {
      totalUsers,
      totalUsersFormatted: formatInteger(totalUsers),
      countries: rows.rows.map((row) => ({
        country: row.country,
        users: Number(row.users || 0),
        usersFormatted: formatInteger(row.users),
      })),
    };
  }

  async function readNetworkSnapshot() {
    const result = await readQuery(`
      SELECT payload, computed_at
      FROM stats_network_snapshot
      WHERE id = 1
      LIMIT 1
    `);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const ageMs = Math.max(0, Date.now() - new Date(row.computed_at).getTime());
    return {
      payload: row.payload,
      ageMs,
    };
  }

  async function readCountrySnapshot() {
    const result = await readQuery(`
      SELECT payload, computed_at
      FROM stats_country_snapshot
      WHERE id = 1
      LIMIT 1
    `);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const ageMs = Math.max(0, Date.now() - new Date(row.computed_at).getTime());
    return {
      payload: row.payload,
      ageMs,
    };
  }

  async function refreshNetworkSnapshot() {
    const payload = await loadNetworkStatsFresh();
    await writeQuery(
      `
        INSERT INTO stats_network_snapshot (id, payload, computed_at)
        VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id)
        DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at
      `,
      [JSON.stringify(payload)]
    );
    return payload;
  }

  async function refreshCountrySnapshot() {
    const payload = await loadCountryStatsFresh();
    await writeQuery(
      `
        INSERT INTO stats_country_snapshot (id, payload, computed_at)
        VALUES (1, $1::jsonb, NOW())
        ON CONFLICT (id)
        DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at
      `,
      [JSON.stringify(payload)]
    );
    return payload;
  }

  function ensureNetworkSnapshotRefresh(fastifyInstance) {
    if (networkSnapshotRefreshInflight) {
      return networkSnapshotRefreshInflight;
    }

    networkSnapshotRefreshInflight = refreshNetworkSnapshot()
      .catch((err) => {
        fastifyInstance.log.warn(err, 'Failed to refresh network stats snapshot');
        return null;
      })
      .finally(() => {
        networkSnapshotRefreshInflight = null;
      });

    return networkSnapshotRefreshInflight;
  }

  function ensureCountrySnapshotRefresh(fastifyInstance) {
    if (countrySnapshotRefreshInflight) {
      return countrySnapshotRefreshInflight;
    }

    countrySnapshotRefreshInflight = refreshCountrySnapshot()
      .catch((err) => {
        fastifyInstance.log.warn(err, 'Failed to refresh country stats snapshot');
        return null;
      })
      .finally(() => {
        countrySnapshotRefreshInflight = null;
      });

    return countrySnapshotRefreshInflight;
  }

  /// 🌐 GET NETWORK STATS
  fastify.get('/network', {
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
  }, async () => {
    try {
      const now = Date.now();
      if (networkStatsCache.payload) {
        if (networkStatsCache.expiresAt <= now) {
          if (!networkStatsInflight) {
            networkStatsInflight = (async () => {
              try {
                let payload = null;

                if (STATS_USE_PRECOMPUTED) {
                  const snapshot = await readNetworkSnapshot();
                  if (snapshot && snapshot.ageMs <= STATS_PRECOMPUTE_MAX_STALE_MS) {
                    payload = snapshot.payload;
                    if (snapshot.ageMs > STATS_PRECOMPUTE_TARGET_AGE_MS) {
                      void ensureNetworkSnapshotRefresh(fastify);
                    }
                  } else {
                    payload = await ensureNetworkSnapshotRefresh(fastify);
                  }
                }

                if (!payload) {
                  payload = await loadNetworkStatsFresh();
                }

                networkStatsCache = {
                  payload,
                  expiresAt: Date.now() + NETWORK_STATS_CACHE_MS,
                };
              } catch (refreshErr) {
                fastify.log.warn(refreshErr, 'Background refresh for network stats failed');
              }
            })().finally(() => {
              networkStatsInflight = null;
            });
          }
        }

        return networkStatsCache.payload;
      }

      if (networkStatsCache.payload && networkStatsCache.expiresAt > now) {
        return networkStatsCache.payload;
      }

      if (!networkStatsInflight) {
        networkStatsInflight = (async () => {
          let payload = null;

          if (STATS_USE_PRECOMPUTED) {
            const snapshot = await readNetworkSnapshot();
            if (snapshot && snapshot.ageMs <= STATS_PRECOMPUTE_MAX_STALE_MS) {
              payload = snapshot.payload;

              if (snapshot.ageMs > STATS_PRECOMPUTE_TARGET_AGE_MS) {
                void ensureNetworkSnapshotRefresh(fastify);
              }
            } else {
              payload = await ensureNetworkSnapshotRefresh(fastify);
            }
          }

          if (!payload) {
            payload = await loadNetworkStatsFresh();
          }

          networkStatsCache = {
            payload,
            expiresAt: Date.now() + NETWORK_STATS_CACHE_MS,
          };
          return payload;
        })().finally(() => {
          networkStatsInflight = null;
        });
      }

      return await networkStatsInflight;

    } catch (err) {
      console.error(err);
      if (networkStatsCache.payload) {
        return networkStatsCache.payload;
      }
      return { error: "Failed to fetch stats" };
    }
  });

  /// 🔗 GET ON-CHAIN TOKEN DATA FOR WALLET
  fastify.get('/onchain/:address', async (req) => {
    try {
      const address = String(req.params.address || '').trim();
      if (!isAddress(address)) {
        return { error: 'Invalid wallet address' };
      }

      const [balanceRes, supplyRes] = await Promise.all([
        callBscScan({
          module: 'account',
          action: 'tokenbalance',
          contractaddress: ANET_CONTRACT,
          address,
          tag: 'latest',
        }),
        callBscScan({
          module: 'stats',
          action: 'tokensupply',
          contractaddress: ANET_CONTRACT,
        }),
      ]);

      if (String(balanceRes.status) !== '1' && !String(balanceRes.message || '').toLowerCase().includes('ok')) {
        return {
          error: 'Failed to read on-chain balance',
          details: balanceRes.result || balanceRes.message || 'Unknown BscScan error',
        };
      }

      const rawBalance = String(balanceRes.result || '0');
      const rawSupply = String(supplyRes.result || '0');

      return {
        contract: ANET_CONTRACT,
        wallet: address,
        decimals: ANET_DECIMALS,
        balanceRaw: rawBalance,
        balanceFormatted: formatUnits(rawBalance, ANET_DECIMALS),
        totalSupplyRaw: rawSupply,
        totalSupplyFormatted: formatUnits(rawSupply, ANET_DECIMALS),
      };
    } catch (err) {
      console.error(err);
      return { error: 'Failed to fetch on-chain token data' };
    }
  });

  fastify.get('/evm/token-balance', {
    config: {
      rateLimit: { max: 25, timeWindow: '1 minute' },
    },
  }, async (req) => {
    try {
      const wallet = String(req.query?.wallet || '').trim();
      const contract = String(req.query?.contract || '').trim();
      const network = String(req.query?.network || 'BNB Smart Chain').trim();
      const decimalsRaw = Number(req.query?.decimals || 18);
      const decimals = Number.isFinite(decimalsRaw)
        ? Math.max(0, Math.min(30, Math.trunc(decimalsRaw)))
        : 18;

      if (!isAddress(wallet) || !isAddress(contract)) {
        return {
          error: 'Invalid wallet or contract address',
        };
      }

      const chainId = resolveEvmChainId(network);
      if (!chainId) {
        return {
          error: 'Unsupported network',
          supportedNetworks: ['BNB Smart Chain', 'Ethereum', 'Polygon'],
        };
      }

      const tokenBalance = await callBscScan({
        module: 'account',
        action: 'tokenbalance',
        chainid: chainId,
        contractaddress: contract,
        address: wallet,
        tag: 'latest',
      });

      if (
        String(tokenBalance.status) !== '1' &&
        !String(tokenBalance.message || '').toLowerCase().includes('ok')
      ) {
        return {
          error: 'Failed to read token balance',
          details: tokenBalance.result || tokenBalance.message || 'Unknown explorer error',
        };
      }

      const raw = String(tokenBalance.result || '0');
      return {
        wallet,
        contract,
        network,
        chainId,
        decimals,
        balanceRaw: raw,
        balanceFormatted: formatUnits(raw, decimals),
      };
    } catch (err) {
      console.error(err);
      return { error: 'Failed to fetch EVM token balance' };
    }
  });

  /// 🌍 GET USERS PER COUNTRY
  fastify.get('/countries', {
    config: {
      rateLimit: { max: 12, timeWindow: '1 minute' },
    },
  }, async () => {
    try {
      const now = Date.now();
      if (countryStatsCache.payload) {
        if (countryStatsCache.expiresAt <= now) {
          if (!countryStatsInflight) {
            countryStatsInflight = (async () => {
              try {
                let payload = null;

                if (STATS_USE_PRECOMPUTED) {
                  const snapshot = await readCountrySnapshot();
                  if (snapshot && snapshot.ageMs <= STATS_PRECOMPUTE_MAX_STALE_MS) {
                    payload = snapshot.payload;
                    if (snapshot.ageMs > STATS_PRECOMPUTE_TARGET_AGE_MS) {
                      void ensureCountrySnapshotRefresh(fastify);
                    }
                  } else {
                    payload = await ensureCountrySnapshotRefresh(fastify);
                  }
                }

                if (!payload) {
                  payload = await loadCountryStatsFresh();
                }

                countryStatsCache = {
                  payload,
                  expiresAt: Date.now() + COUNTRY_STATS_CACHE_MS,
                };
              } catch (refreshErr) {
                fastify.log.warn(refreshErr, 'Background refresh for country stats failed');
              }
            })().finally(() => {
              countryStatsInflight = null;
            });
          }
        }

        return countryStatsCache.payload;
      }

      if (countryStatsCache.payload && countryStatsCache.expiresAt > now) {
        return countryStatsCache.payload;
      }

      if (!countryStatsInflight) {
        countryStatsInflight = (async () => {
          let payload = null;

          if (STATS_USE_PRECOMPUTED) {
            const snapshot = await readCountrySnapshot();
            if (snapshot && snapshot.ageMs <= STATS_PRECOMPUTE_MAX_STALE_MS) {
              payload = snapshot.payload;

              if (snapshot.ageMs > STATS_PRECOMPUTE_TARGET_AGE_MS) {
                void ensureCountrySnapshotRefresh(fastify);
              }
            } else {
              payload = await ensureCountrySnapshotRefresh(fastify);
            }
          }

          if (!payload) {
            payload = await loadCountryStatsFresh();
          }

          countryStatsCache = {
            payload,
            expiresAt: Date.now() + COUNTRY_STATS_CACHE_MS,
          };
          return payload;
        })().finally(() => {
          countryStatsInflight = null;
        });
      }

      return await countryStatsInflight;
    } catch (err) {
      console.error(err);
      if (countryStatsCache.payload) {
        return countryStatsCache.payload;
      }
      return { error: 'Failed to fetch country users' };
    }
  });

};