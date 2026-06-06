const DEFAULTS = {
  staleUnverifiedHours: 72,
  staleIpClusterThreshold: 8,
  staleFingerprintClusterThreshold: 4,
  staleDeviceClusterThreshold: 3,
  flaggedRiskThreshold: 8,
  verifiedReviewIpClusterThreshold: 12,
  verifiedReviewFingerprintClusterThreshold: 3,
  verifiedReviewDeviceClusterThreshold: 2,
  verifiedReviewSessionPatternThreshold: 4,
  previewSampleLimit: 25,
};

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function cleanupConfig() {
  return {
    staleUnverifiedHours: envInt('BOT_CLEANUP_STALE_UNVERIFIED_HOURS', DEFAULTS.staleUnverifiedHours),
    staleIpClusterThreshold: envInt('BOT_CLEANUP_IP_CLUSTER_THRESHOLD', DEFAULTS.staleIpClusterThreshold),
    staleFingerprintClusterThreshold: envInt(
      'BOT_CLEANUP_FINGERPRINT_CLUSTER_THRESHOLD',
      DEFAULTS.staleFingerprintClusterThreshold
    ),
    staleDeviceClusterThreshold: envInt(
      'BOT_CLEANUP_DEVICE_CLUSTER_THRESHOLD',
      DEFAULTS.staleDeviceClusterThreshold
    ),
    flaggedRiskThreshold: envInt('BOT_CLEANUP_FLAGGED_RISK_THRESHOLD', DEFAULTS.flaggedRiskThreshold),
    verifiedReviewIpClusterThreshold: envInt(
      'BOT_REVIEW_VERIFIED_IP_CLUSTER_THRESHOLD',
      DEFAULTS.verifiedReviewIpClusterThreshold
    ),
    verifiedReviewFingerprintClusterThreshold: envInt(
      'BOT_REVIEW_VERIFIED_FINGERPRINT_CLUSTER_THRESHOLD',
      DEFAULTS.verifiedReviewFingerprintClusterThreshold
    ),
    verifiedReviewDeviceClusterThreshold: envInt(
      'BOT_REVIEW_VERIFIED_DEVICE_CLUSTER_THRESHOLD',
      DEFAULTS.verifiedReviewDeviceClusterThreshold
    ),
    verifiedReviewSessionPatternThreshold: envInt(
      'BOT_REVIEW_VERIFIED_SESSION_PATTERN_THRESHOLD',
      DEFAULTS.verifiedReviewSessionPatternThreshold
    ),
    previewSampleLimit: envInt('BOT_CLEANUP_PREVIEW_SAMPLE_LIMIT', DEFAULTS.previewSampleLimit),
  };
}

function summarizeCandidates(candidates) {
  const byReason = {};
  for (const candidate of candidates) {
    for (const reason of candidate.reasons || []) {
      byReason[reason] = (byReason[reason] || 0) + 1;
    }
  }

  return Object.entries(byReason)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => ({ reason, count }));
}

async function findCleanupCandidates(db, options = {}) {
  const cfg = {
    ...cleanupConfig(),
    ...options,
  };

  const res = await db.query(
    `WITH ip_clusters AS (
       SELECT last_ip, COUNT(*)::int AS cluster_size
       FROM users
       WHERE last_ip IS NOT NULL
         AND TRIM(last_ip) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY last_ip
     ),
     device_clusters AS (
       SELECT device_id, COUNT(*)::int AS cluster_size
       FROM users
       WHERE device_id IS NOT NULL
         AND TRIM(device_id) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY device_id
     ),
     fingerprint_clusters AS (
       SELECT device_fingerprint, COUNT(*)::int AS cluster_size
       FROM users
       WHERE device_fingerprint IS NOT NULL
         AND TRIM(device_fingerprint) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY device_fingerprint
     ),
     candidate_rows AS (
       SELECT
         u.id,
         u.email,
         u.created_at,
         COALESCE(u.email_verified, FALSE) AS email_verified,
         COALESCE(u.successful_sessions, 0)::int AS successful_sessions,
         COALESCE(u.claimed_anet, 0)::numeric AS claimed_anet,
         COALESCE(u.is_flagged, FALSE) AS is_flagged,
         COALESCE(u.risk_score, 0)::int AS risk_score,
         COALESCE(ip.cluster_size, 0)::int AS ip_cluster_size,
         COALESCE(dev.cluster_size, 0)::int AS device_cluster_size,
         COALESCE(fp.cluster_size, 0)::int AS fingerprint_cluster_size,
         ARRAY_REMOVE(ARRAY[
           CASE
             WHEN COALESCE(u.email_verified, FALSE) = FALSE
               AND COALESCE(u.successful_sessions, 0) = 0
               AND COALESCE(u.claimed_anet, 0) = 0
               AND COALESCE(u.created_at, NOW()) < NOW() - ($1::int * INTERVAL '1 hour')
             THEN 'stale_unverified'
           END,
           CASE
             WHEN COALESCE(u.email_verified, FALSE) = FALSE
               AND COALESCE(u.successful_sessions, 0) = 0
               AND COALESCE(u.claimed_anet, 0) = 0
               AND COALESCE(ip.cluster_size, 0) >= $2::int
             THEN 'shared_ip_unverified'
           END,
           CASE
             WHEN COALESCE(u.email_verified, FALSE) = FALSE
               AND COALESCE(u.successful_sessions, 0) = 0
               AND COALESCE(u.claimed_anet, 0) = 0
               AND COALESCE(dev.cluster_size, 0) >= $3::int
             THEN 'shared_device_unverified'
           END,
           CASE
             WHEN COALESCE(u.email_verified, FALSE) = FALSE
               AND COALESCE(u.successful_sessions, 0) = 0
               AND COALESCE(u.claimed_anet, 0) = 0
               AND COALESCE(fp.cluster_size, 0) >= $4::int
             THEN 'shared_fingerprint_unverified'
           END,
           CASE
             WHEN COALESCE(u.email_verified, FALSE) = FALSE
               AND COALESCE(u.claimed_anet, 0) = 0
               AND COALESCE(u.successful_sessions, 0) <= 1
               AND (COALESCE(u.is_flagged, FALSE) = TRUE OR COALESCE(u.risk_score, 0) >= $5::int)
             THEN 'flagged_unverified'
           END
         ], NULL) AS reasons
       FROM users u
       LEFT JOIN ip_clusters ip ON ip.last_ip = u.last_ip
       LEFT JOIN device_clusters dev ON dev.device_id = u.device_id
       LEFT JOIN fingerprint_clusters fp ON fp.device_fingerprint = u.device_fingerprint
       WHERE COALESCE(u.is_deleted, FALSE) = FALSE
     )
     SELECT *
     FROM candidate_rows
     WHERE COALESCE(array_length(reasons, 1), 0) > 0
     ORDER BY created_at ASC NULLS FIRST, id ASC`,
    [
      cfg.staleUnverifiedHours,
      cfg.staleIpClusterThreshold,
      cfg.staleDeviceClusterThreshold,
      cfg.staleFingerprintClusterThreshold,
      cfg.flaggedRiskThreshold,
    ]
  );

  return (res.rows || []).map((row) => ({
    id: Number(row.id),
    email: String(row.email || ''),
    createdAt: row.created_at,
    emailVerified: row.email_verified === true,
    successfulSessions: Number(row.successful_sessions || 0),
    claimedAnet: Number(row.claimed_anet || 0),
    riskScore: Number(row.risk_score || 0),
    isFlagged: row.is_flagged === true,
    ipClusterSize: Number(row.ip_cluster_size || 0),
    deviceClusterSize: Number(row.device_cluster_size || 0),
    fingerprintClusterSize: Number(row.fingerprint_cluster_size || 0),
    reasons: Array.isArray(row.reasons) ? row.reasons.filter(Boolean) : [],
  }));
}

async function previewCleanup(db, options = {}) {
  const cfg = {
    ...cleanupConfig(),
    ...options,
  };
  const candidates = await findCleanupCandidates(db, cfg);
  return {
    totalCandidates: candidates.length,
    byReason: summarizeCandidates(candidates),
    sample: candidates.slice(0, cfg.previewSampleLimit),
  };
}

async function applyCleanup(db, options = {}) {
  const cfg = {
    ...cleanupConfig(),
    ...options,
  };
  const candidates = await findCleanupCandidates(db, cfg);
  const ids = candidates.map((candidate) => candidate.id);

  if (ids.length === 0) {
    return {
      deletedCount: 0,
      byReason: [],
      sample: [],
    };
  }

  await db.query('BEGIN');
  try {
    await db.query(
      `UPDATE users
       SET is_deleted = TRUE,
           is_mining = FALSE,
           session_end_time = NULL,
           last_mining_start = NULL,
           updated_at = NOW()
       WHERE id = ANY($1::int[])`,
      [ids]
    );

    await db.query(
      `UPDATE mining_sessions
       SET status = 'cancelled',
           is_completed = FALSE,
           end_time = COALESCE(end_time, NOW())
       WHERE user_id = ANY($1::int[])
         AND COALESCE(is_completed, FALSE) = FALSE`,
      [ids]
    );

    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }

  return {
    deletedCount: ids.length,
    byReason: summarizeCandidates(candidates),
    sample: candidates.slice(0, cfg.previewSampleLimit),
  };
}

async function previewVerifiedReview(db, options = {}) {
  const cfg = {
    ...cleanupConfig(),
    ...options,
  };

  const res = await db.query(
    `WITH ip_clusters AS (
       SELECT last_ip, COUNT(*)::int AS cluster_size
       FROM users
       WHERE last_ip IS NOT NULL
         AND TRIM(last_ip) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY last_ip
     ),
     device_clusters AS (
       SELECT device_id, COUNT(*)::int AS cluster_size
       FROM users
       WHERE device_id IS NOT NULL
         AND TRIM(device_id) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY device_id
     ),
     fingerprint_clusters AS (
       SELECT device_fingerprint, COUNT(*)::int AS cluster_size
       FROM users
       WHERE device_fingerprint IS NOT NULL
         AND TRIM(device_fingerprint) <> ''
         AND COALESCE(is_deleted, FALSE) = FALSE
       GROUP BY device_fingerprint
     ),
     session_patterns AS (
       SELECT
         ms.user_id,
         COUNT(*)::int AS completed_sessions,
         (MAX(EXTRACT(EPOCH FROM ms.start_time)) - MIN(EXTRACT(EPOCH FROM ms.start_time)))::bigint AS start_span_seconds,
         BOOL_AND(
           EXTRACT(EPOCH FROM (COALESCE(ms.end_time, ms.start_time) - ms.start_time)) BETWEEN 21300 AND 21900
         ) AS perfect_duration_pattern
       FROM mining_sessions ms
       WHERE COALESCE(ms.is_completed, FALSE) = TRUE
       GROUP BY ms.user_id
     )
     SELECT
       u.id,
       u.email,
       u.created_at,
       COALESCE(u.successful_sessions, 0)::int AS successful_sessions,
       COALESCE(u.claimed_anet, 0)::numeric AS claimed_anet,
       COALESCE(u.risk_score, 0)::int AS risk_score,
       COALESCE(u.is_flagged, FALSE) AS is_flagged,
       COALESCE(ip.cluster_size, 0)::int AS ip_cluster_size,
       COALESCE(dev.cluster_size, 0)::int AS device_cluster_size,
       COALESCE(fp.cluster_size, 0)::int AS fingerprint_cluster_size,
       COALESCE(sp.completed_sessions, 0)::int AS completed_sessions,
       COALESCE(sp.start_span_seconds, 0)::bigint AS start_span_seconds,
       COALESCE(sp.perfect_duration_pattern, FALSE) AS perfect_duration_pattern,
       ARRAY_REMOVE(ARRAY[
         CASE
           WHEN COALESCE(u.is_flagged, FALSE) = TRUE OR COALESCE(u.risk_score, 0) >= $1::int
           THEN 'flagged_verified'
         END,
         CASE
           WHEN COALESCE(dev.cluster_size, 0) >= $2::int
           THEN 'shared_device_verified'
         END,
         CASE
           WHEN COALESCE(fp.cluster_size, 0) >= $3::int
           THEN 'shared_fingerprint_verified'
         END,
         CASE
           WHEN COALESCE(ip.cluster_size, 0) >= $4::int
           THEN 'shared_ip_verified'
         END,
         CASE
           WHEN COALESCE(sp.completed_sessions, 0) >= $5::int
             AND COALESCE(sp.start_span_seconds, 999999999) <= 120
           THEN 'identical_start_time_pattern'
         END,
         CASE
           WHEN COALESCE(sp.completed_sessions, 0) >= $5::int
             AND COALESCE(sp.perfect_duration_pattern, FALSE) = TRUE
           THEN 'perfect_duration_pattern'
         END
       ], NULL) AS reasons
     FROM users u
     LEFT JOIN ip_clusters ip ON ip.last_ip = u.last_ip
     LEFT JOIN device_clusters dev ON dev.device_id = u.device_id
     LEFT JOIN fingerprint_clusters fp ON fp.device_fingerprint = u.device_fingerprint
     LEFT JOIN session_patterns sp ON sp.user_id = u.id
     WHERE COALESCE(u.is_deleted, FALSE) = FALSE
       AND COALESCE(u.email_verified, FALSE) = TRUE
     ORDER BY COALESCE(u.risk_score, 0) DESC, COALESCE(u.successful_sessions, 0) DESC, u.id ASC`,
    [
      cfg.flaggedRiskThreshold,
      cfg.verifiedReviewDeviceClusterThreshold,
      cfg.verifiedReviewFingerprintClusterThreshold,
      cfg.verifiedReviewIpClusterThreshold,
      cfg.verifiedReviewSessionPatternThreshold,
    ]
  );

  const candidates = (res.rows || [])
    .map((row) => ({
      id: Number(row.id),
      email: String(row.email || ''),
      createdAt: row.created_at,
      successfulSessions: Number(row.successful_sessions || 0),
      claimedAnet: Number(row.claimed_anet || 0),
      riskScore: Number(row.risk_score || 0),
      isFlagged: row.is_flagged === true,
      ipClusterSize: Number(row.ip_cluster_size || 0),
      deviceClusterSize: Number(row.device_cluster_size || 0),
      fingerprintClusterSize: Number(row.fingerprint_cluster_size || 0),
      completedSessionsReviewed: Number(row.completed_sessions || 0),
      sessionStartSpanSeconds: Number(row.start_span_seconds || 0),
      perfectDurationPattern: row.perfect_duration_pattern === true,
      reasons: Array.isArray(row.reasons) ? row.reasons.filter(Boolean) : [],
    }))
    .filter((row) => row.reasons.length > 0);

  return {
    totalCandidates: candidates.length,
    byReason: summarizeCandidates(candidates),
    sample: candidates.slice(0, cfg.previewSampleLimit),
  };
}

module.exports = {
  cleanupConfig,
  findCleanupCandidates,
  previewCleanup,
  applyCleanup,
  previewVerifiedReview,
};