const API_REVISION = '2026-04-19-v1.0.5-launch-tranche';
const MAX_SUPPLY = 21000000;
const ANTS_PER_ANET = 100000000;
const MAX_SUPPLY_ANTS = MAX_SUPPLY * ANTS_PER_ANET;
const SESSIONS_PER_DAY = 4;
const SESSION_HOURS = 6;
const SESSION_SECONDS = SESSION_HOURS * 60 * 60;
const LEGACY_LAUNCH_SESSIONS = 500000;
const LEGACY_LAUNCH_REWARD_ANTS = 4882812;
const LEGACY_LAUNCH_REWARD_ANET = LEGACY_LAUNCH_REWARD_ANTS / ANTS_PER_ANET;
const MAX_HALVING_STAGE = 9;
const MAX_CYCLES = MAX_HALVING_STAGE + 1;
const HALVING_INTERVAL = 3800000000;
const REQUIRED_SESSIONS_FOR_ELIGIBILITY = 1000;
const BASE_REWARD_ANTS = 262144;
const BASE_REWARD_ANET = BASE_REWARD_ANTS / ANTS_PER_ANET;

function getPostLaunchSessions(totalSessions) {
  return Math.max(0, Number(totalSessions || 0) - LEGACY_LAUNCH_SESSIONS);
}

function getHalvingStage(totalSessions) {
  const stage = Math.floor(getPostLaunchSessions(totalSessions) / HALVING_INTERVAL);
  return Math.max(0, Math.min(stage, MAX_HALVING_STAGE));
}

function calculateRate(halvingStage, totalSessions) {
  return antsToAnet(calculateRewardAnts(halvingStage, totalSessions));
}

function calculateRewardAnts(halvingStage, totalSessions) {
  if (Number(totalSessions || 0) < LEGACY_LAUNCH_SESSIONS) {
    return LEGACY_LAUNCH_REWARD_ANTS;
  }

  const stage = Math.max(
    0,
    Math.min(Number(halvingStage || 0), MAX_HALVING_STAGE)
  );
  return Math.floor(BASE_REWARD_ANTS / (2 ** stage));
}

function getNextRewardPerSession(halvingStage, totalSessions) {
  if (Number(totalSessions || 0) < LEGACY_LAUNCH_SESSIONS) {
    return BASE_REWARD_ANET;
  }

  const nextStage = Math.min(Number(halvingStage || 0) + 1, MAX_HALVING_STAGE);
  return calculateRate(nextStage, totalSessions);
}

function anetToAnts(amount) {
  return Math.floor(Number(amount || 0) * ANTS_PER_ANET);
}

function antsToAnet(ants) {
  return Number(ants || 0) / ANTS_PER_ANET;
}

function formatInteger(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return '0';
  }

  return Math.round(numeric).toLocaleString('en-US');
}

function formatDecimal(value, maxFractionDigits = 8) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) {
    return '0';
  }

  return numeric.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
}

function buildUserMiningState(row) {
  const totalSessions = Math.max(
    Number(row?.successful_sessions || 0),
    Number(row?.total_sessions || 0),
    Number(row?.totalSessions || 0)
  );
  const totalANTS = Math.max(
    Number(row?.ants_balance || 0),
    Number(row?.ant_balance || 0),
    Number(row?.totalANTS || 0)
  );
  const claimedANET = Number(row?.claimed_anet || row?.claimedANET || 0);

  return {
    id: String(row?.id || ''),
    totalSessions,
    totalANTS,
    isEligible: totalSessions >= REQUIRED_SESSIONS_FOR_ELIGIBILITY,
    hasClaimed: claimedANET > 0,
    claimedANET: Number(claimedANET.toFixed(8)),
  };
}

function buildGlobalState(overrides = {}) {
  const totalSessions = Number(overrides.totalSessions || 0);
  const totalUsers = Number(overrides.totalUsers || 0);
  const totalRegisteredAccounts = Number(overrides.totalRegisteredAccounts || 0);
  const totalRealMiners = Number(overrides.totalRealMiners || 0);
  const usersOnline = Number(overrides.usersOnline || 0);
  const totalCompletedSessions = Number(
    overrides.totalCompletedSessions ?? totalSessions
  );
  const totalActiveMiners = Number(overrides.totalActiveMiners || 0);
  const totalEligibleUsers = Number(overrides.totalEligibleUsers || 0);
  const totalConvertedUsers = Number(overrides.totalConvertedUsers || 0);
  const totalANTSAccumulated = Number(overrides.totalANTSAccumulated || 0);
  const totalANETClaimed = Number(Number(overrides.totalANETClaimed || 0).toFixed(8));
  const inLaunchPhase = totalSessions < LEGACY_LAUNCH_SESSIONS;
  const postLaunchSessions = getPostLaunchSessions(totalSessions);
  const halvingStage = Number.isFinite(Number(overrides.halvingStage))
    ? Number(overrides.halvingStage)
    : getHalvingStage(totalSessions);
  const currentRewardPerSession = Number(
    (overrides.currentRewardPerSession ?? calculateRate(halvingStage, totalSessions)).toFixed(8)
  );
  const currentRewardPerSessionAnts = Number(
    overrides.currentRewardPerSessionAnts ?? calculateRewardAnts(halvingStage, totalSessions)
  );
  const nextRewardPerSession = Number(
    (overrides.nextRewardPerSession ?? getNextRewardPerSession(halvingStage, totalSessions)).toFixed(8)
  );
  const nextRewardPerSessionAnts = Number(
    overrides.nextRewardPerSessionAnts ?? (
      inLaunchPhase
        ? BASE_REWARD_ANTS
        : calculateRewardAnts(Math.min(halvingStage + 1, MAX_HALVING_STAGE), totalSessions)
    )
  );
  const activeInterval = inLaunchPhase ? LEGACY_LAUNCH_SESSIONS : HALVING_INTERVAL;
  const progressSessions = inLaunchPhase
    ? totalSessions
    : halvingStage >= MAX_HALVING_STAGE
      ? HALVING_INTERVAL
      : postLaunchSessions % HALVING_INTERVAL;
  const nextHalvingProgress = (!inLaunchPhase && halvingStage >= MAX_HALVING_STAGE)
    ? 100
    : Number(((progressSessions / activeInterval) * 100).toFixed(2));
  const remainingSessionsToHalving = (!inLaunchPhase && halvingStage >= MAX_HALVING_STAGE)
    ? 0
    : Math.max(0, activeInterval - progressSessions);

  return {
    apiRevision: API_REVISION,
    totalUsers,
    totalUsersFormatted: formatInteger(totalUsers),
    totalRegisteredAccounts,
    totalRegisteredAccountsFormatted: formatInteger(totalRegisteredAccounts),
    totalRealMiners,
    totalRealMinersFormatted: formatInteger(totalRealMiners),
    usersOnline,
    usersOnlineFormatted: formatInteger(usersOnline),
    totalSessions,
    totalSessionsFormatted: formatInteger(totalSessions),
    totalCompletedSessions,
    totalCompletedSessionsFormatted: formatInteger(totalCompletedSessions),
    totalActiveMiners,
    totalActiveMinersFormatted: formatInteger(totalActiveMiners),
    totalEligibleUsers,
    totalEligibleUsersFormatted: formatInteger(totalEligibleUsers),
    totalConvertedUsers,
    totalConvertedUsersFormatted: formatInteger(totalConvertedUsers),
    totalANTSAccumulated,
    totalANTSAccumulatedFormatted: formatInteger(totalANTSAccumulated),
    totalANETClaimed,
    totalANETClaimedFormatted: formatDecimal(totalANETClaimed, 8),
    maxSupply: MAX_SUPPLY,
    maxSupplyAnts: MAX_SUPPLY_ANTS,
    antsPerAnet: ANTS_PER_ANET,
    launchPhaseSessions: LEGACY_LAUNCH_SESSIONS,
    launchRewardPerSession: LEGACY_LAUNCH_REWARD_ANET,
    launchRewardPerSessionAnts: LEGACY_LAUNCH_REWARD_ANTS,
    isLaunchPhase: inLaunchPhase,
    currentRewardPerSession,
    currentRewardPerSessionAnts,
    nextRewardPerSession,
    nextRewardPerSessionAnts,
    halvingStage,
    maxHalvingStage: MAX_HALVING_STAGE,
    halvingTrigger: 'total_sessions',
    halvingInterval: activeInterval,
    sessionDurationHours: SESSION_HOURS,
    cyclePerDay: SESSIONS_PER_DAY,
    requiredSessionsForEligibility: REQUIRED_SESSIONS_FOR_ELIGIBILITY,
    isMiningActive: Boolean(overrides.isMiningActive),
    presenceWindowMinutes: Number(overrides.presenceWindowMinutes || 5),
    nextHalvingProgress,
    remainingSessionsToHalving,
  };
}

function safeConvert(user, globalState) {
  if (Number(user?.totalSessions || 0) < REQUIRED_SESSIONS_FOR_ELIGIBILITY) {
    return 0;
  }

  let anet = Number(user?.totalANTS || 0) / ANTS_PER_ANET;
  if (Number(globalState?.totalANETClaimed || 0) + anet > MAX_SUPPLY) {
    anet = MAX_SUPPLY - Number(globalState?.totalANETClaimed || 0);
  }

  return Math.max(Number(anet.toFixed(8)), 0);
}

module.exports = {
  API_REVISION,
  calculateRate,
  calculateRewardAnts,
  getHalvingStage,
  getPostLaunchSessions,
  getNextRewardPerSession,
  MAX_SUPPLY,
  ANTS_PER_ANET,
  MAX_SUPPLY_ANTS,
  SESSIONS_PER_DAY,
  SESSION_HOURS,
  SESSION_SECONDS,
  LEGACY_LAUNCH_SESSIONS,
  LEGACY_LAUNCH_REWARD_ANTS,
  LEGACY_LAUNCH_REWARD_ANET,
  MAX_CYCLES,
  MAX_HALVING_STAGE,
  HALVING_INTERVAL,
  REQUIRED_SESSIONS_FOR_ELIGIBILITY,
  BASE_REWARD_ANTS,
  BASE_REWARD_ANET,
  anetToAnts,
  antsToAnet,
  buildUserMiningState,
  buildGlobalState,
  safeConvert,
};