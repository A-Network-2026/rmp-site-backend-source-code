const { REQUIRED_SESSIONS_FOR_ELIGIBILITY } = require('../services/miningEngine');

const SESSION_GATE_REQUIRED_SESSIONS = Math.max(
  1,
  Number(process.env.SESSION_GATE_REQUIRED_SESSIONS || REQUIRED_SESSIONS_FOR_ELIGIBILITY || 1000)
);

function parseCsvSet(value, normalize = (v) => v) {
  return new Set(
    String(value || '')
      .split(',')
      .map((v) => normalize(v.trim()))
      .filter(Boolean)
  );
}

const SESSION_GATE_BYPASS_USER_IDS = parseCsvSet(
  process.env.SESSION_GATE_BYPASS_USER_IDS,
  (v) => String(Number(v) || '')
);

const SESSION_GATE_BYPASS_EMAILS = parseCsvSet(
  process.env.SESSION_GATE_BYPASS_EMAILS,
  (v) => v.toLowerCase()
);

function isSessionGateBypassed({ userId, email } = {}) {
  const normalizedId = String(Number(userId) || '');
  if (normalizedId && SESSION_GATE_BYPASS_USER_IDS.has(normalizedId)) {
    return true;
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (normalizedEmail && SESSION_GATE_BYPASS_EMAILS.has(normalizedEmail)) {
    return true;
  }

  return false;
}

module.exports = {
  SESSION_GATE_REQUIRED_SESSIONS,
  isSessionGateBypassed,
};
