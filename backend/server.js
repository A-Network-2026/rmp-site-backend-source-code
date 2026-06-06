// deploy: 2026-05-18
require('dotenv').config();

const trustProxy = process.env.FASTIFY_TRUST_PROXY
  ? String(process.env.FASTIFY_TRUST_PROXY).toLowerCase() === 'true'
  : Boolean(process.env.RENDER);

const pluginTimeout = Number(process.env.FASTIFY_PLUGIN_TIMEOUT_MS || 120000);

const fastify = require('fastify')({ logger: true, trustProxy, pluginTimeout });
const compress = require('@fastify/compress');
const cors = require('@fastify/cors');
const rateLimit = require('@fastify/rate-limit');
const db = require('./db');
const { startNotificationWorker } = require('./services/notificationWorker');
const { startAdsSupportWorker } = require('./services/adsSupportWorker');
const { startValidatorWorker } = require('./services/validatorWorker');
const AUTO_BLOCK_ENABLED = String(process.env.STATS_AUTO_BLOCK_ENABLED || 'false').toLowerCase() !== 'false';
const AUTO_BLOCK_THRESHOLD = Math.max(2, Number(process.env.STATS_AUTO_BLOCK_THRESHOLD || 3));
const AUTO_BLOCK_WINDOW_MS = Math.max(10000, Number(process.env.STATS_AUTO_BLOCK_WINDOW_MS || 5 * 60 * 1000));
const AUTO_BLOCK_DURATION_MS = Math.max(30000, Number(process.env.STATS_AUTO_BLOCK_DURATION_MS || 15 * 60 * 1000));
const AUTO_BLOCK_ESCALATION_FACTOR = Math.max(1, Number(process.env.STATS_AUTO_BLOCK_ESCALATION_FACTOR || 2));
const AUTO_BLOCK_MAX_DURATION_MS = Math.max(AUTO_BLOCK_DURATION_MS, Number(process.env.STATS_AUTO_BLOCK_MAX_DURATION_MS || 6 * 60 * 60 * 1000));
const AUTO_BLOCK_STRIKE_RESET_MS = Math.max(60000, Number(process.env.STATS_AUTO_BLOCK_STRIKE_RESET_MS || 24 * 60 * 60 * 1000));
const SUBNET_COOLDOWN_ENABLED = String(process.env.STATS_SUBNET_COOLDOWN_ENABLED || 'false').toLowerCase() !== 'false';
const SUBNET_COOLDOWN_THRESHOLD = Math.max(3, Number(process.env.STATS_SUBNET_COOLDOWN_THRESHOLD || 12));
const SUBNET_COOLDOWN_WINDOW_MS = Math.max(10000, Number(process.env.STATS_SUBNET_COOLDOWN_WINDOW_MS || 60 * 1000));
const SUBNET_COOLDOWN_DURATION_MS = Math.max(30000, Number(process.env.STATS_SUBNET_COOLDOWN_DURATION_MS || 2 * 60 * 1000));
const GLOBAL_RATE_LIMIT_MAX = Math.max(200, Number(process.env.RATE_LIMIT_MAX || 1500));
const GLOBAL_RATE_LIMIT_WINDOW = process.env.RATE_LIMIT_WINDOW || '15 minutes';

const statsAbuseCounters = new Map();
const statsAutoBlocks = new Map();
const statsAutoBlockStrikes = new Map();
const subnetAbuseCounters = new Map();
const subnetCooldownBlocks = new Map();

function isStatsUrl(url) {
  return String(url || '').startsWith('/stats/');
}

function resolveAbuseSubject(request) {
  const ip = String(request.ip || '').trim() || 'unknown_ip';
  const deviceId = String(request.headers['x-device-id'] || '').trim() || null;
  const deviceFingerprint = String(request.headers['x-device-fingerprint'] || '').trim() || null;

  let subject = `ip:${ip}`;
  if (deviceFingerprint) {
    subject += `|fp:${deviceFingerprint}`;
  } else if (deviceId) {
    subject += `|dev:${deviceId}`;
  }

  return {
    ip,
    deviceId,
    deviceFingerprint,
    subject,
  };
}

function isUnauthenticatedStatsRequest(request) {
  if (!isStatsUrl(request.url)) {
    return false;
  }

  if (request.user?.userId || request.user?.id) {
    return false;
  }

  return !Boolean(request.headers.authorization);
}

function resolveRateLimitKey(request) {
  const deviceId = String(request.headers['x-device-id'] || '').trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }

  const authHeader = String(request.headers.authorization || '').trim();
  if (authHeader.toLowerCase().startsWith('bearer ') && authHeader.length > 20) {
    return `bearer:${authHeader.slice(7, 31)}`;
  }

  return `ip:${String(request.ip || 'unknown')}`;
}

function pruneExpiredAutoBlocks(now) {
  for (const [subject, block] of statsAutoBlocks.entries()) {
    if (Number(block?.expiresAt || 0) <= now) {
      statsAutoBlocks.delete(subject);
    }
  }

  for (const [subnet, block] of subnetCooldownBlocks.entries()) {
    if (Number(block?.expiresAt || 0) <= now) {
      subnetCooldownBlocks.delete(subnet);
    }
  }
}

function resolveSubnetKey(ip) {
  const raw = String(ip || '').trim();
  const ipv4 = raw.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) {
    return `ip:${raw || 'unknown_ip'}`;
  }

  return `ipv4:${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
}

function resolveNextStrike(now, subject) {
  const prior = statsAutoBlockStrikes.get(subject);
  if (!prior || Number(prior.lastStrikeAt || 0) <= (now - AUTO_BLOCK_STRIKE_RESET_MS)) {
    return 1;
  }

  return prior.strikes + 1;
}

function resolveEscalatedDurationMs(strikes) {
  const multiplier = Math.pow(AUTO_BLOCK_ESCALATION_FACTOR, Math.max(0, strikes - 1));
  const rawDuration = Math.round(AUTO_BLOCK_DURATION_MS * multiplier);
  return Math.min(AUTO_BLOCK_MAX_DURATION_MS, Math.max(AUTO_BLOCK_DURATION_MS, rawDuration));
}

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

fastify.register(cors, {
  origin: allowedOrigins.length > 0 ? allowedOrigins : false,
});

fastify.register(compress, {
  global: true,
  encodings: ['gzip', 'deflate'],
  threshold: 1024,
});

fastify.register(rateLimit, {
  global: true,
  max: GLOBAL_RATE_LIMIT_MAX,
  timeWindow: GLOBAL_RATE_LIMIT_WINDOW,
  keyGenerator: resolveRateLimitKey,
});

/// 🔐 SECURITY HEADERS
fastify.addHook('onSend', async (request, reply) => {
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '1; mode=block');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'");
});

fastify.addHook('preHandler', async (request, reply) => {
  if (!AUTO_BLOCK_ENABLED || !isUnauthenticatedStatsRequest(request)) {
    return;
  }

  const now = Date.now();
  pruneExpiredAutoBlocks(now);

  const identity = resolveAbuseSubject(request);
  const subnetKey = resolveSubnetKey(identity.ip);

  if (SUBNET_COOLDOWN_ENABLED) {
    const subnetBlock = subnetCooldownBlocks.get(subnetKey);
    if (subnetBlock && Number(subnetBlock.expiresAt || 0) > now) {
      const retrySeconds = Math.max(1, Math.ceil((subnetBlock.expiresAt - now) / 1000));
      request.log.warn(
        {
          event: 'stats_subnet_cooldown_active',
          subnet: subnetKey,
          ip: identity.ip,
          deviceId: identity.deviceId,
          deviceFingerprint: identity.deviceFingerprint,
          url: request.url,
          retrySeconds,
        },
        'Blocked unauthenticated stats request due to subnet cool-down'
      );

      return reply.code(429).send({
        error: `Subnet temporarily cooled down due to repeated abuse. Retry in ${retrySeconds} seconds.`,
      });
    }
  }

  const block = statsAutoBlocks.get(identity.subject);
  if (!block || Number(block.expiresAt || 0) <= now) {
    return;
  }

  const retrySeconds = Math.max(1, Math.ceil((block.expiresAt - now) / 1000));
  request.log.warn(
    {
      event: 'stats_auto_block_active',
      subject: identity.subject,
      ip: identity.ip,
      deviceId: identity.deviceId,
      deviceFingerprint: identity.deviceFingerprint,
      url: request.url,
      retrySeconds,
    },
    'Blocked repeated unauthenticated stats scraper'
  );

  return reply.code(429).send({
    error: `Temporarily blocked due to repeated abuse. Retry in ${retrySeconds} seconds.`,
  });
});

fastify.addHook('onResponse', async (request, reply) => {
  if (reply.statusCode !== 429) {
    return;
  }

  if (AUTO_BLOCK_ENABLED && isUnauthenticatedStatsRequest(request)) {
    const now = Date.now();
    const identity = resolveAbuseSubject(request);
    const subnetKey = resolveSubnetKey(identity.ip);
    const current = statsAbuseCounters.get(identity.subject);

    if (!current || (now - current.windowStart) > AUTO_BLOCK_WINDOW_MS) {
      statsAbuseCounters.set(identity.subject, {
        count: 1,
        windowStart: now,
      });
    } else {
      current.count += 1;
      statsAbuseCounters.set(identity.subject, current);

      if (current.count >= AUTO_BLOCK_THRESHOLD) {
        const strikes = resolveNextStrike(now, identity.subject);
        const blockDurationMs = resolveEscalatedDurationMs(strikes);

        statsAutoBlocks.set(identity.subject, {
          expiresAt: now + blockDurationMs,
          reason: 'repeated_429_on_unauth_stats',
          strikes,
        });
        statsAutoBlockStrikes.set(identity.subject, {
          strikes,
          lastStrikeAt: now,
        });
        statsAbuseCounters.delete(identity.subject);

        request.log.warn(
          {
            event: 'stats_auto_block_applied',
            subject: identity.subject,
            ip: identity.ip,
            deviceId: identity.deviceId,
            deviceFingerprint: identity.deviceFingerprint,
            url: request.url,
            threshold: AUTO_BLOCK_THRESHOLD,
            strikes,
            blockDurationMs,
            escalationFactor: AUTO_BLOCK_ESCALATION_FACTOR,
          },
          'Applied temporary auto-block for repeated unauthenticated stats abuse'
        );
      }
    }

    if (SUBNET_COOLDOWN_ENABLED) {
      const subnetCounter = subnetAbuseCounters.get(subnetKey);
      if (!subnetCounter || (now - subnetCounter.windowStart) > SUBNET_COOLDOWN_WINDOW_MS) {
        subnetAbuseCounters.set(subnetKey, {
          count: 1,
          windowStart: now,
        });
      } else {
        subnetCounter.count += 1;
        subnetAbuseCounters.set(subnetKey, subnetCounter);

        if (subnetCounter.count >= SUBNET_COOLDOWN_THRESHOLD) {
          subnetCooldownBlocks.set(subnetKey, {
            expiresAt: now + SUBNET_COOLDOWN_DURATION_MS,
            reason: 'subnet_unauth_stats_429_burst',
          });
          subnetAbuseCounters.delete(subnetKey);

          request.log.warn(
            {
              event: 'stats_subnet_cooldown_applied',
              subnet: subnetKey,
              ip: identity.ip,
              url: request.url,
              threshold: SUBNET_COOLDOWN_THRESHOLD,
              windowMs: SUBNET_COOLDOWN_WINDOW_MS,
              cooldownDurationMs: SUBNET_COOLDOWN_DURATION_MS,
            },
            'Applied temporary subnet cool-down for unauthenticated stats abuse burst'
          );
        }
      }
    }
  }

  request.log.warn(
    {
      event: 'rate_limit_blocked',
      reqId: request.id,
      method: request.method,
      url: request.url,
      ip: request.ip,
      userId: request.user?.userId || request.user?.id || null,
      deviceId: String(request.headers['x-device-id'] || '').trim() || null,
      deviceFingerprint: String(request.headers['x-device-fingerprint'] || '').trim() || null,
      userAgent: request.headers['user-agent'] || null,
      hasAuthorizationHeader: Boolean(request.headers.authorization),
      responseTimeMs: reply.elapsedTime,
    },
    'Request blocked by rate limiter'
  );
});

fastify.get('/', async () => {
  return { status: "API running" };
});

fastify.get('/.well-known/pi/config.json', {
  config: { rateLimit: { max: 200, timeWindow: '15 minutes' } },
}, async (request, reply) => {
  reply.header('Content-Type', 'application/json');
  reply.header('Cache-Control', 'public, max-age=3600');
  return {
    appId: process.env.PI_APP_ID || 'YOUR_PI_APP_ID',
    scopes: ['payments', 'username'],
    sandbox: process.env.PI_SANDBOX !== 'false',
  };
});

async function start() {
  try {
    // waitForDatabase retries until the DB is reachable. During rolling deploys
    // both instances share the same DB; if slots are exhausted we still want to
    // boot and serve cached/stateless routes rather than hard-crash.
    try {
      await db.waitForDatabase();
    } catch (dbErr) {
      console.error('[server] DB not reachable at startup (will retry per-request):', dbErr.message);
      // Do NOT exit — let the server start; per-request handlers have their own
      // error paths and the pool will reconnect once slots free up.
    }

    await fastify.register(require('./routes/auth'), { prefix: '/auth' });
    await fastify.register(require('./routes/portal'), { prefix: '/auth/portal' });
    await fastify.register(require('./routes/waitlist'), { prefix: '/waitlist' });
    await fastify.register(require('./routes/mining'), { prefix: '/mining' });
    await fastify.register(require('./routes/leaderboard'), { prefix: '/leaderboard' });
    await fastify.register(require('./routes/stats'), { prefix: '/stats' });
    await fastify.register(require('./routes/user'), { prefix: '/user' });
    await fastify.register(require('./routes/adsSupport'));
    await fastify.register(require('./routes/adsSsv'));
    await fastify.register(require('./routes/admin'), { prefix: '/admin' });
    await fastify.register(require('./routes/colonyRewards'), { prefix: '/colony-rewards' });
    await fastify.register(require('./routes/blockchain'), { prefix: '/blockchain' });
    await fastify.register(require('./routes/chatbot'), { prefix: '/chatbot' });
    await fastify.register(require('./routes/walletNft'), { prefix: '/wallet/nft' });
    await fastify.register(require('./routes/validator'), { prefix: '/validator' });

    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    startNotificationWorker(60000);
    startAdsSupportWorker(db);
    startValidatorWorker(db, undefined, fastify.log);
  } catch (err) {
    fastify.log.error(err, 'Backend startup failed');
    process.exit(1);
  }
}

start();