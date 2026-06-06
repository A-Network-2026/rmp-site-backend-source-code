'use strict';

/**
 * validatorEngine.js
 *
 * Core business logic for the A Network Automated Validator Eligibility System.
 *
 * Validator States:
 *   INELIGIBLE → user does not pass all eligibility gates
 *   ELIGIBLE   → all gates pass; user has not yet self-activated
 *   ACTIVE     → actively participating in validation tasks
 *   SUSPENDED  → suspended due to inactivity, low reputation, or admin action
 *
 * Eligibility Gates (all must pass):
 *   1. Email verified
 *   2. Wallet address set
 *   3. Migration wallet address set
 *   4. ≥ 1 successful mining session
 *   5. ≥ 1,000 total sessions
 *
 * This module is pure Node.js with no Fastify imports — safe to use
 * in routes, workers, and background jobs alike.
 */

const crypto = require('crypto');
const { buildValidatorCandidateState } = require('./sessionProofs');

// ── Status / result enums ────────────────────────────────────────────

const STATUS = Object.freeze({
  INELIGIBLE: 'INELIGIBLE',
  ELIGIBLE:   'ELIGIBLE',
  ACTIVE:     'ACTIVE',
  SUSPENDED:  'SUSPENDED',
});

const TASK_STATUS = Object.freeze({
  PENDING:   'PENDING',
  COMPLETED: 'COMPLETED',
  EXPIRED:   'EXPIRED',
  SKIPPED:   'SKIPPED',
});

const RESULT = Object.freeze({
  VALID:   'VALID',
  INVALID: 'INVALID',
  ABSTAIN: 'ABSTAIN',
});

// ── Tuning constants (overridable via env) ───────────────────────────

const VALIDATORS_PER_SESSION  = Math.max(1, Number(process.env.VALIDATORS_PER_SESSION    || 3));
const TASK_DEADLINE_HOURS     = Math.max(1, Number(process.env.VALIDATOR_TASK_DEADLINE_HOURS || 24));
const INACTIVITY_DAYS         = Math.max(1, Number(process.env.VALIDATOR_INACTIVITY_DAYS  || 7));
const REWARD_BASE_ANTS        = Math.max(0, Number(process.env.VALIDATOR_REWARD_BASE_ANTS || 10));
const REWARD_ACCURACY_BONUS   = Math.max(0, Number(process.env.VALIDATOR_ACCURACY_BONUS   || 5));
const REWARD_STREAK_BONUS     = Math.max(0, Number(process.env.VALIDATOR_STREAK_BONUS     || 2));
const STREAK_THRESHOLD        = Math.max(1, Number(process.env.VALIDATOR_STREAK_THRESHOLD || 30));
const REP_CORRECT             =  1.0;
const REP_INCORRECT           = -2.0;
const REP_ABSTAIN             = -0.5;
const REP_EXPIRE_PENALTY      = -0.25;
const REP_MIN_FLOOR           = -50;
const REP_SUSPEND_THRESHOLD   = Number(process.env.VALIDATOR_SUSPEND_REP || -20);

// ── Allowed profile field keys (whitelist prevents SQL injection) ─────

const ALLOWED_PROFILE_KEYS = new Set([
  'status',
  'activated_at',
  'suspended_at',
  'suspension_reason',
  'last_active_at',
  'cooldown_until',
]);

// ── Schema bootstrap ─────────────────────────────────────────────────

let schemaReady = false;

async function ensureValidatorSchema(db) {
  if (schemaReady) return;
  try {
    await db.query('SELECT 1 FROM validator_profiles LIMIT 0');
    schemaReady = true;
  } catch {
    throw new Error(
      'Validator schema not ready. Run migration_validator_system_2026_05_15.sql first.'
    );
  }
}

// ── Gate computation ─────────────────────────────────────────────────

/**
 * Returns per-gate eligibility for a users-table row.
 * No DB calls — pure computation.
 */
function computeGates(user) {
  const sessions = Number(user.successful_sessions ?? user.total_sessions ?? 0);
  const riskOk   = Number(user.risk_score ?? 0) <
                   Number(process.env.VALIDATOR_RISK_THRESHOLD || 10);

  const emailVerified      = Boolean(user.email_verified);
  const walletSet          = Boolean(user.wallet_address);
  const migrationWalletSet = Boolean(user.migration_wallet_address);
  const hasSession         = sessions >= 1;
  const has1kSessions      = sessions >= 1000;

  return {
    emailVerified,
    walletSet,
    migrationWalletSet,
    hasSession,
    has1kSessions,
    sessions,
    allPassed: emailVerified && walletSet && migrationWalletSet &&
               has1kSessions && !user.is_banned && riskOk,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

async function _fetchUser(userId, db) {
  const res = await db.query(
    `SELECT id, email_verified, wallet_address, migration_wallet_address,
            successful_sessions, total_sessions, is_banned, risk_score,
            validator_status, validator_key, validator_joined_at, validator_reputation
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return res.rows[0] ?? null;
}

/**
 * UPSERT into validator_profiles.
 * fields keys must be a subset of ALLOWED_PROFILE_KEYS.
 */
async function _upsertProfile(userId, fields, db) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([k]) => ALLOWED_PROFILE_KEYS.has(k))
  );
  if (Object.keys(safeFields).length === 0) return;

  const keys   = Object.keys(safeFields);
  const values = Object.values(safeFields);

  // Build parameterised SET clauses for the ON CONFLICT path
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');

  await db.query(
    `INSERT INTO validator_profiles (user_id, ${keys.join(', ')}, updated_at)
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, NOW())
     ON CONFLICT (user_id) DO UPDATE SET ${setClauses}, updated_at = NOW()`,
    [userId, ...values]
  );
}

/**
 * Fire-and-forget audit log — never blocks or throws to caller.
 */
async function _log(validatorUserId, eventType, targetSessionId, taskId, metadata, db) {
  try {
    await db.query(
      `INSERT INTO validation_logs
         (event_type, validator_user_id, target_session_id, task_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        eventType,
        validatorUserId ?? null,
        targetSessionId ?? null,
        taskId         ?? null,
        JSON.stringify(metadata ?? {}),
      ]
    );
  } catch (_) { /* intentional: never break caller */ }
}

// ── Core eligibility sync ────────────────────────────────────────────

/**
 * Re-evaluate all gates for userId.
 * Updates validator_profiles; also syncs users.validator_status if needed.
 * Safe to call after every mining session completion (fire-and-forget).
 *
 * State machine:
 *   INELIGIBLE + gates pass  → ELIGIBLE
 *   ELIGIBLE   + gates fail  → INELIGIBLE
 *   ACTIVE     + gates fail  → INELIGIBLE
 *   SUSPENDED               → no auto-change (admin/reactivation required)
 */
async function checkAndSyncEligibility(userId, db) {
  const user = await _fetchUser(userId, db);
  if (!user) return null;

  const gates = computeGates(user);

  const profileRes = await db.query(
    'SELECT status FROM validator_profiles WHERE user_id = $1',
    [userId]
  );
  const currentStatus = profileRes.rows[0]?.status ?? STATUS.INELIGIBLE;

  // SUSPENDED validators require explicit admin/reactivation — do not auto-change
  if (currentStatus === STATUS.SUSPENDED) {
    await _log(userId, 'ELIGIBILITY_CHECK', null, null, { gates, action: 'skipped_suspended' }, db);
    return { status: STATUS.SUSPENDED, gates };
  }

  let newStatus = currentStatus;

  if (gates.allPassed) {
    if (currentStatus === STATUS.INELIGIBLE) {
      newStatus = STATUS.ELIGIBLE;
    }
    // ELIGIBLE and ACTIVE: no downgrade — user keeps their status
  } else {
    // Gates failed: demote back to INELIGIBLE (wallet removed, banned, etc.)
    if (currentStatus === STATUS.ACTIVE || currentStatus === STATUS.ELIGIBLE) {
      newStatus = STATUS.INELIGIBLE;
    }
  }

  if (newStatus !== currentStatus) {
    await _upsertProfile(userId, { status: newStatus }, db);

    // Sync users table (backward-compat with existing mining code)
    if (gates.allPassed) {
      const candidate = buildValidatorCandidateState({
        wallet:          user.wallet_address,
        migrationWallet: user.migration_wallet_address,
        emailVerified:   Boolean(user.email_verified),
        isBanned:        Boolean(user.is_banned),
        riskScore:       Number(user.risk_score ?? 0),
        totalSessions:   gates.sessions,
      });
      if (candidate.isValidatorCandidate) {
        await db.query(
          `UPDATE users
           SET is_validator_candidate = TRUE,
               validator_status       = $2,
               validator_joined_at    = COALESCE(validator_joined_at, NOW()),
               validator_key          = COALESCE(validator_key, $3),
               validator_reputation   = COALESCE(validator_reputation, 0)
           WHERE id = $1`,
          [userId, candidate.validatorStatus, candidate.validatorKey]
        );
      }
    } else {
      await db.query(
        `UPDATE users
         SET is_validator_candidate = FALSE, validator_status = 'MINER'
         WHERE id = $1`,
        [userId]
      );
    }

    await _log(userId, 'ELIGIBILITY_CHECK', null, null,
      { gates, previousStatus: currentStatus, newStatus }, db);
  }

  return { status: newStatus, gates };
}

// ── Activation ───────────────────────────────────────────────────────

/**
 * Promote ELIGIBLE → ACTIVE.
 * The user explicitly calls this endpoint — no auto-activation.
 */
async function activateValidator(userId, db) {
  const profileRes = await db.query(
    'SELECT status FROM validator_profiles WHERE user_id = $1',
    [userId]
  );
  const profile = profileRes.rows[0];

  if (!profile || profile.status === STATUS.INELIGIBLE) {
    throw Object.assign(
      new Error('Not eligible. Complete all validator gates first.'),
      { code: 'NOT_ELIGIBLE' }
    );
  }
  if (profile.status === STATUS.SUSPENDED) {
    throw Object.assign(
      new Error('Validator is suspended. Contact support or wait for automatic review.'),
      { code: 'SUSPENDED' }
    );
  }
  if (profile.status === STATUS.ACTIVE) {
    return { status: STATUS.ACTIVE, alreadyActive: true };
  }

  await _upsertProfile(userId, {
    status:         STATUS.ACTIVE,
    activated_at:   new Date(),
    last_active_at: new Date(),
  }, db);

  await _log(userId, 'ACTIVATED', null, null, {}, db);
  return { status: STATUS.ACTIVE };
}

// ── Suspension ───────────────────────────────────────────────────────

async function suspendValidator(userId, reason, db) {
  await _upsertProfile(userId, {
    status:             STATUS.SUSPENDED,
    suspended_at:       new Date(),
    suspension_reason:  String(reason ?? 'Administrative suspension').slice(0, 255),
  }, db);

  await db.query(
    `UPDATE users
     SET validator_status = 'SUSPENDED', is_validator_candidate = FALSE
     WHERE id = $1`,
    [userId]
  );

  await _log(userId, 'SUSPENDED', null, null, { reason }, db);
}

// ── Reactivation ─────────────────────────────────────────────────────

async function reactivateValidator(userId, db) {
  const user = await _fetchUser(userId, db);
  if (!user) throw new Error('User not found');

  const gates = computeGates(user);
  if (!gates.allPassed) {
    throw Object.assign(
      new Error('User does not meet all eligibility gates'),
      { code: 'NOT_ELIGIBLE', gates }
    );
  }

  await _upsertProfile(userId, {
    status:             STATUS.ACTIVE,
    activated_at:       new Date(),
    suspended_at:       null,
    suspension_reason:  null,
    cooldown_until:     null,
    last_active_at:     new Date(),
  }, db);

  await db.query(
    `UPDATE users
     SET validator_status = 'VALIDATOR_CANDIDATE', is_validator_candidate = TRUE
     WHERE id = $1`,
    [userId]
  );

  await _log(userId, 'REACTIVATED', null, null, { gates }, db);
}

// ── Task assignment ──────────────────────────────────────────────────

/**
 * Assign up to VALIDATORS_PER_SESSION random ACTIVE validators to review
 * the given mining session. Skips the session owner to prevent self-validation.
 */
async function assignValidationTasks(targetSessionId, sessionUserId, db) {
  // Idempotency — do not double-assign
  const existing = await db.query(
    'SELECT 1 FROM validator_tasks WHERE target_session_id = $1 LIMIT 1',
    [targetSessionId]
  );
  if (existing.rows.length > 0) return [];

  // Pick random ACTIVE validators not on cooldown, excluding session owner
  const candidatesRes = await db.query(
    `SELECT vp.user_id
     FROM validator_profiles vp
     WHERE vp.status = $1
       AND ($2::integer IS NULL OR vp.user_id <> $2)
       AND (vp.cooldown_until IS NULL OR vp.cooldown_until < NOW())
     ORDER BY random()
     LIMIT $3`,
    [STATUS.ACTIVE, sessionUserId ?? null, VALIDATORS_PER_SESSION]
  );

  if (candidatesRes.rows.length === 0) return [];

  const deadline = new Date(Date.now() + TASK_DEADLINE_HOURS * 3_600_000);
  const tasks    = [];

  for (const row of candidatesRes.rows) {
    const taskRes = await db.query(
      `INSERT INTO validator_tasks (target_session_id, validator_user_id, deadline_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [targetSessionId, row.user_id, deadline]
    );
    const taskId = taskRes.rows[0].id;
    tasks.push({ taskId, validatorUserId: row.user_id });
    await _log(row.user_id, 'TASK_ASSIGNED', targetSessionId, taskId, {}, db);
  }

  return tasks;
}

// ── Submit validation result ─────────────────────────────────────────

async function submitValidationResult(taskId, validatorUserId, result, db) {
  if (!Object.values(RESULT).includes(result)) {
    throw Object.assign(
      new Error(`Invalid result "${result}". Must be VALID, INVALID, or ABSTAIN.`),
      { code: 'INVALID_RESULT' }
    );
  }

  const taskRes = await db.query(
    `SELECT id, status, target_session_id, validator_user_id, deadline_at
     FROM validator_tasks
     WHERE id = $1`,
    [taskId]
  );
  const task = taskRes.rows[0];

  if (!task) throw Object.assign(new Error('Task not found'), { code: 'NOT_FOUND' });
  if (Number(task.validator_user_id) !== Number(validatorUserId)) {
    throw Object.assign(new Error('This task was not assigned to you'), { code: 'FORBIDDEN' });
  }
  if (task.status !== TASK_STATUS.PENDING) {
    throw Object.assign(
      new Error(`Task already ${task.status}`),
      { code: 'ALREADY_SUBMITTED' }
    );
  }
  if (new Date() > new Date(task.deadline_at)) {
    await db.query(
      'UPDATE validator_tasks SET status = $1 WHERE id = $2',
      [TASK_STATUS.EXPIRED, taskId]
    );
    throw Object.assign(new Error('Task deadline has passed'), { code: 'EXPIRED' });
  }

  const proofHash = crypto.createHash('sha256')
    .update(`${taskId}|${validatorUserId}|${result}|${Date.now()}`)
    .digest('hex');

  await db.query(
    `UPDATE validator_tasks
     SET status = $1, result = $2, submitted_at = NOW(), proof_hash = $3
     WHERE id = $4`,
    [TASK_STATUS.COMPLETED, result, proofHash, taskId]
  );

  await db.query(
    `UPDATE validator_profiles
     SET last_active_at    = NOW(),
         total_validations = total_validations + 1
     WHERE user_id = $1`,
    [validatorUserId]
  );

  await _log(validatorUserId, 'TASK_COMPLETED', task.target_session_id, taskId,
    { result, proofHash }, db);

  // Auto-trigger consensus when all assigned tasks are resolved
  const pendingRes = await db.query(
    `SELECT 1 FROM validator_tasks
     WHERE target_session_id = $1 AND status = 'PENDING' LIMIT 1`,
    [task.target_session_id]
  );
  let consensus = null;
  if (pendingRes.rows.length === 0) {
    consensus = await processConsensus(task.target_session_id, db);
  }

  return { taskId, result, proofHash, consensus };
}

// ── Consensus processing ─────────────────────────────────────────────

async function processConsensus(targetSessionId, db) {
  const tasksRes = await db.query(
    `SELECT id, validator_user_id, result, status
     FROM validator_tasks
     WHERE target_session_id = $1`,
    [targetSessionId]
  );

  const completed = tasksRes.rows.filter(t => t.status === TASK_STATUS.COMPLETED);
  if (completed.length === 0) return null;

  // Simple majority vote
  const tally = { [RESULT.VALID]: 0, [RESULT.INVALID]: 0, [RESULT.ABSTAIN]: 0 };
  for (const t of completed) {
    tally[t.result] = (tally[t.result] ?? 0) + 1;
  }
  const consensusResult = tally[RESULT.VALID] >= tally[RESULT.INVALID]
    ? RESULT.VALID
    : RESULT.INVALID;

  await _log(null,
    consensusResult === RESULT.VALID ? 'CONSENSUS_VALID' : 'CONSENSUS_INVALID',
    targetSessionId, null, { tally, participantCount: completed.length }, db);

  // Per-validator reputation + reward
  for (const task of completed) {
    const correct  = task.result === consensusResult;
    const abstain  = task.result === RESULT.ABSTAIN;
    const repDelta = abstain ? REP_ABSTAIN : (correct ? REP_CORRECT : REP_INCORRECT);

    const repRes = await updateReputation(
      task.validator_user_id,
      repDelta,
      `Consensus: voted ${task.result} (${correct ? 'correct' : 'incorrect'})`,
      db
    );

    // Auto-suspend on reputation floor breach
    if (repRes.newBalance <= REP_SUSPEND_THRESHOLD) {
      await suspendValidator(
        task.validator_user_id,
        'Reputation dropped below suspension threshold',
        db
      );
    }

    // Accumulate streak
    const streakRes = await db.query(
      'SELECT streak_count FROM validator_profiles WHERE user_id = $1',
      [task.validator_user_id]
    );
    const streak    = Number(streakRes.rows[0]?.streak_count ?? 0);
    const newStreak = (correct && !abstain) ? streak + 1 : 0;

    await db.query(
      `UPDATE validator_profiles
       SET successful_validations = successful_validations + $1,
           failed_validations     = failed_validations     + $2,
           streak_count           = $3
       WHERE user_id = $4`,
      [correct ? 1 : 0, correct ? 0 : 1, newStreak, task.validator_user_id]
    );

    // Reward records
    if (REWARD_BASE_ANTS > 0) {
      await db.query(
        `INSERT INTO validator_rewards (user_id, task_id, reward_type, amount_ants)
         VALUES ($1, $2, 'VALIDATION_BASE', $3)`,
        [task.validator_user_id, task.id, REWARD_BASE_ANTS]
      );
    }
    if (correct && !abstain && REWARD_ACCURACY_BONUS > 0) {
      await db.query(
        `INSERT INTO validator_rewards (user_id, task_id, reward_type, amount_ants)
         VALUES ($1, $2, 'ACCURACY_BONUS', $3)`,
        [task.validator_user_id, task.id, REWARD_ACCURACY_BONUS]
      );
    }
    if (newStreak >= STREAK_THRESHOLD && REWARD_STREAK_BONUS > 0) {
      await db.query(
        `INSERT INTO validator_rewards (user_id, task_id, reward_type, amount_ants)
         VALUES ($1, $2, 'STREAK_BONUS', $3)`,
        [task.validator_user_id, task.id, REWARD_STREAK_BONUS]
      );
    }
  }

  return { consensusResult, tally };
}

// ── Reputation ───────────────────────────────────────────────────────

async function updateReputation(userId, delta, reason, db) {
  const res = await db.query(
    'SELECT reputation_score FROM validator_profiles WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  const current    = Number(res.rows[0]?.reputation_score ?? 0);
  const newBalance = Math.max(REP_MIN_FLOOR, current + delta);

  await db.query(
    'UPDATE validator_profiles SET reputation_score = $1 WHERE user_id = $2',
    [newBalance, userId]
  );
  await db.query(
    `INSERT INTO validator_reputation_history (user_id, delta, reason, balance_after)
     VALUES ($1, $2, $3, $4)`,
    [userId, delta, String(reason ?? '').slice(0, 120), newBalance]
  );
  await _log(userId, 'REPUTATION_UPDATE', null, null, { delta, reason, newBalance }, db);

  return { newBalance };
}

// ── Background sweeps ────────────────────────────────────────────────

/**
 * Suspend ACTIVE validators who have had no task activity for INACTIVITY_DAYS.
 * Safe to run on a recurring interval.
 */
async function sweepInactiveValidators(db) {
  const res = await db.query(
    `UPDATE validator_profiles
     SET status            = $1,
         suspended_at      = NOW(),
         suspension_reason = 'Inactivity',
         updated_at        = NOW()
     WHERE status = $2
       AND (
         last_active_at IS NULL
         OR last_active_at < NOW() - $3 * INTERVAL '1 day'
       )
     RETURNING user_id`,
    [STATUS.SUSPENDED, STATUS.ACTIVE, INACTIVITY_DAYS]
  );

  for (const row of res.rows) {
    await db.query(
      `UPDATE users
       SET validator_status = 'SUSPENDED', is_validator_candidate = FALSE
       WHERE id = $1`,
      [row.user_id]
    );
    await _log(row.user_id, 'SUSPENDED', null, null, { reason: 'Inactivity' }, db);
  }

  return res.rows.length;
}

/**
 * Expire PENDING tasks whose deadline has passed and apply a small
 * reputation penalty to the assigned validator.
 */
async function expireOverdueTasks(db) {
  const res = await db.query(
    `UPDATE validator_tasks
     SET status = $1
     WHERE status = $2 AND deadline_at < NOW()
     RETURNING id, validator_user_id, target_session_id`,
    [TASK_STATUS.EXPIRED, TASK_STATUS.PENDING]
  );

  for (const row of res.rows) {
    await _log(row.validator_user_id, 'TASK_EXPIRED',
      row.target_session_id, row.id, {}, db);

    const repRes = await updateReputation(
      row.validator_user_id,
      REP_EXPIRE_PENALTY,
      'Task expired without submission',
      db
    );
    if (repRes.newBalance <= REP_SUSPEND_THRESHOLD) {
      await suspendValidator(
        row.validator_user_id,
        'Reputation dropped below suspension threshold',
        db
      );
    }
  }

  return res.rows.length;
}

// ── Query helpers ────────────────────────────────────────────────────

async function getValidatorProfile(userId, db) {
  const [userRes, profileRes] = await Promise.all([
    _fetchUser(userId, db),
    db.query('SELECT * FROM validator_profiles WHERE user_id = $1', [userId]),
  ]);

  if (!userRes) return null;
  const gates   = computeGates(userRes);
  const profile = profileRes.rows[0] ?? null;

  return {
    userId,
    status:                profile?.status                  ?? STATUS.INELIGIBLE,
    activatedAt:           profile?.activated_at            ?? null,
    suspendedAt:           profile?.suspended_at            ?? null,
    suspensionReason:      profile?.suspension_reason       ?? null,
    lastActiveAt:          profile?.last_active_at          ?? null,
    cooldownUntil:         profile?.cooldown_until          ?? null,
    reputationScore:       Number(profile?.reputation_score ?? 0),
    streakCount:           Number(profile?.streak_count     ?? 0),
    totalValidations:      Number(profile?.total_validations ?? 0),
    successfulValidations: Number(profile?.successful_validations ?? 0),
    failedValidations:     Number(profile?.failed_validations     ?? 0),
    gates,
  };
}

async function getValidatorStats(userId, db) {
  const profile = await getValidatorProfile(userId, db);
  if (!profile) return null;

  const rewardsRes = await db.query(
    `SELECT reward_type, SUM(amount_ants) AS total_ants, COUNT(*) AS count
     FROM validator_rewards
     WHERE user_id = $1
     GROUP BY reward_type`,
    [userId]
  );

  let totalRewardAnts = 0;
  const rewards = {};
  for (const row of rewardsRes.rows) {
    rewards[row.reward_type] = {
      totalAnts: Number(row.total_ants),
      count:     Number(row.count),
    };
    totalRewardAnts += Number(row.total_ants);
  }

  return {
    ...profile,
    rewards,
    totalRewardAnts,
    accuracy: profile.totalValidations > 0
      ? Math.round((profile.successfulValidations / profile.totalValidations) * 100)
      : null,
  };
}

async function getLeaderboard(limit, db) {
  const safeLimit = Math.min(Number(limit ?? 50), 100);
  const res = await db.query(
    `SELECT vp.user_id,
            vp.reputation_score,
            vp.total_validations,
            vp.successful_validations,
            vp.streak_count,
            vp.status,
            u.email
     FROM validator_profiles vp
     JOIN users u ON u.id = vp.user_id
     WHERE vp.status IN ('ELIGIBLE', 'ACTIVE')
     ORDER BY vp.reputation_score DESC, vp.successful_validations DESC
     LIMIT $1`,
    [safeLimit]
  );

  return res.rows.map((row, i) => {
    // Mask email: "ab***@domain.tld"
    const email = row.email
      ? `${row.email.slice(0, 2)}***${row.email.slice(row.email.indexOf('@'))}`
      : null;
    return {
      rank:                  i + 1,
      userId:                row.user_id,
      email,
      reputationScore:       Number(row.reputation_score),
      totalValidations:      Number(row.total_validations),
      successfulValidations: Number(row.successful_validations),
      streakCount:           Number(row.streak_count),
      status:                row.status,
    };
  });
}

async function listValidators(statusFilter, limit, offset, db) {
  const safeLimit  = Math.min(Number(limit  ?? 50),  200);
  const safeOffset = Math.max(Number(offset ?? 0), 0);
  const validStatus = Object.values(STATUS);

  let whereClause = '';
  let params = [safeLimit, safeOffset];

  if (validStatus.includes(statusFilter)) {
    whereClause = 'WHERE vp.status = $3';
    params.push(statusFilter);
  }

  const res = await db.query(
    `SELECT vp.user_id,
            vp.status,
            vp.reputation_score,
            vp.total_validations,
            vp.successful_validations,
            vp.streak_count,
            vp.activated_at,
            vp.suspended_at,
            vp.suspension_reason,
            vp.last_active_at,
            u.email,
            u.wallet_address
     FROM validator_profiles vp
     JOIN users u ON u.id = vp.user_id
     ${whereClause}
     ORDER BY vp.reputation_score DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  return res.rows;
}

async function getValidationHistory(userId, limit, offset, db) {
  const safeLimit  = Math.min(Number(limit  ?? 20), 100);
  const safeOffset = Math.max(Number(offset ?? 0), 0);

  const res = await db.query(
    `SELECT vt.id,
            vt.target_session_id,
            vt.status,
            vt.result,
            vt.assigned_at,
            vt.deadline_at,
            vt.submitted_at,
            COALESCE(vr.total_reward, 0) AS reward_ants
     FROM validator_tasks vt
     LEFT JOIN (
       SELECT task_id, SUM(amount_ants) AS total_reward
       FROM validator_rewards
       GROUP BY task_id
     ) vr ON vr.task_id = vt.id
     WHERE vt.validator_user_id = $1
     ORDER BY vt.assigned_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, safeLimit, safeOffset]
  );

  return res.rows;
}

async function getPendingTasks(userId, db) {
  const res = await db.query(
    `SELECT id, target_session_id, assigned_at, deadline_at
     FROM validator_tasks
     WHERE validator_user_id = $1
       AND status = 'PENDING'
       AND deadline_at > NOW()
     ORDER BY deadline_at ASC`,
    [userId]
  );
  return res.rows;
}

// ── Exports ──────────────────────────────────────────────────────────

module.exports = {
  STATUS,
  TASK_STATUS,
  RESULT,
  ensureValidatorSchema,
  computeGates,
  checkAndSyncEligibility,
  activateValidator,
  suspendValidator,
  reactivateValidator,
  assignValidationTasks,
  submitValidationResult,
  processConsensus,
  updateReputation,
  sweepInactiveValidators,
  expireOverdueTasks,
  getValidatorProfile,
  getValidatorStats,
  getLeaderboard,
  listValidators,
  getValidationHistory,
  getPendingTasks,
};
