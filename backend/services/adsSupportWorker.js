const { logAudit } = require('./antiAbuse');

function intFromEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

function getAdsSupportConfig() {
  const minImpressions = intFromEnv(
    'SUPPORTER_MIN_IMPRESSIONS',
    intFromEnv('SUPPORTER_MIN_ADS', 30)
  );

  return {
    minDays: intFromEnv('SUPPORTER_MIN_DAYS', 3),
    minImpressions,
    workerMinutes: intFromEnv('SUPPORTER_WORKER_MINUTES', 60),
  };
}

async function refreshSupporterBadges(db) {
  const cfg = getAdsSupportConfig();

  const assignedRes = await db.query(
    `UPDATE users
     SET supporter_badge = TRUE,
         supporter_since = COALESCE(supporter_since, NOW()),
         updated_at = NOW()
     WHERE COALESCE(is_deleted, FALSE) = FALSE
       AND COALESCE(ads_active, TRUE) = TRUE
       AND COALESCE(supporter_badge, FALSE) = FALSE
       AND (
         (ads_started_at IS NOT NULL AND ads_started_at <= NOW() - ($1::int * INTERVAL '1 day'))
         OR COALESCE(total_ad_impressions, 0) >= $2
       )
     RETURNING id, total_ad_impressions, ads_started_at`,
    [cfg.minDays, cfg.minImpressions]
  );

  for (const row of assignedRes.rows) {
    await logAudit(db, {
      eventType: 'supporter_badge_assigned',
      userId: row.id,
      details: {
        minDays: cfg.minDays,
        minImpressions: cfg.minImpressions,
        totalAdImpressions: Number(row.total_ad_impressions || 0),
        adsStartedAt: row.ads_started_at || null,
      },
    });
  }

  return {
    assignedCount: assignedRes.rowCount || 0,
    config: cfg,
  };
}

function startAdsSupportWorker(db) {
  const cfg = getAdsSupportConfig();
  const everyMs = Math.max(5, cfg.workerMinutes) * 60 * 1000;

  const timer = setInterval(async () => {
    try {
      const summary = await refreshSupporterBadges(db);
      if (summary.assignedCount > 0) {
        console.log(
          `[AdsSupport] supporter badges updated assigned=${summary.assignedCount}`
        );
      }
    } catch (err) {
      console.error('[AdsSupport] worker error:', err.message || err);
    }
  }, everyMs);

  refreshSupporterBadges(db).catch((err) => {
    console.error('[AdsSupport] initial worker run error:', err.message || err);
  });

  return timer;
}

module.exports = {
  getAdsSupportConfig,
  refreshSupporterBadges,
  startAdsSupportWorker,
};
