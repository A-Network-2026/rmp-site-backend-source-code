const crypto = require('crypto');

const DEFAULT_TPOW_SECRET =
  process.env.TPOW_VALIDATOR_SECRET ||
  process.env.ANET_TPOW_SECRET ||
  process.env.JWT_SECRET ||
  'anet-tpow-bootstrap-secret';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function hmacSha256(value) {
  return crypto.createHmac('sha256', DEFAULT_TPOW_SECRET).update(String(value || '')).digest('hex');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function buildChallengeHash({ wallet, migrationWallet, timestamp, randomSeed, currentBlockHash }) {
  const challengeTimestamp = new Date(timestamp || Date.now()).toISOString();
  const challengeHash = sha256([
    normalizeText(wallet).toLowerCase(),
    normalizeText(migrationWallet).toLowerCase(),
    challengeTimestamp,
    normalizeText(randomSeed),
    normalizeText(currentBlockHash) || 'GENESIS',
  ].join('|'));

  return {
    challengeHash,
    challengeTimestamp,
  };
}

function buildProofHash({ sessionId, challengeHash, startTime, endTime, wallet, heartbeatCount, nonce }) {
  return sha256([
    normalizeText(sessionId),
    normalizeText(challengeHash),
    new Date(startTime || Date.now()).toISOString(),
    new Date(endTime || Date.now()).toISOString(),
    normalizeText(wallet).toLowerCase(),
    String(Number(heartbeatCount || 0)),
    normalizeText(nonce),
  ].join('|'));
}

function signValidatorProof(proofHash) {
  return hmacSha256(proofHash);
}

function verifyValidatorSignature(proofHash, validatorSignature) {
  const expected = signValidatorProof(proofHash);
  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(normalizeText(validatorSignature), 'hex');

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function buildValidatorCandidateState({ wallet, migrationWallet, emailVerified, isBanned, riskScore, totalSessions }) {
  const eligible = Boolean(
    normalizeText(wallet) &&
    normalizeText(migrationWallet) &&
    emailVerified &&
    !isBanned &&
    Number(riskScore || 0) < Number(process.env.VALIDATOR_RISK_THRESHOLD || 10) &&
    Number(totalSessions || 0) >= 1000
  );

  return {
    isValidatorCandidate: eligible,
    validatorStatus: eligible ? 'VALIDATOR_CANDIDATE' : 'MINER',
    validatorJoinedAt: eligible ? new Date().toISOString() : null,
    validatorReputation: eligible ? 0 : null,
    validatorKey: eligible
      ? sha256([normalizeText(wallet).toLowerCase(), normalizeText(migrationWallet).toLowerCase()].join('|'))
      : null,
  };
}

async function fetchCurrentBlockHash() {
  const baseUrl = normalizeText(process.env.ANET_L1_URL);
  if (!baseUrl) {
    return 'GENESIS';
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/blocks?limit=1`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        return 'GENESIS';
      }

      const payload = await response.json();
      const block = Array.isArray(payload) ? payload[payload.length - 1] : payload?.blocks?.[payload.blocks.length - 1];
      return normalizeText(block?.hash || block?.block_hash || block?.id) || 'GENESIS';
    } finally {
      clearTimeout(timeout);
    }
  } catch (_) {
    return 'GENESIS';
  }
}

async function createSessionChallenge({ wallet, migrationWallet }) {
  const currentBlockHash = await fetchCurrentBlockHash();
  const randomSeed = crypto.randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const { challengeHash, challengeTimestamp } = buildChallengeHash({
    wallet,
    migrationWallet,
    timestamp,
    randomSeed,
    currentBlockHash,
  });

  return {
    challengeHash,
    challengeTimestamp,
    currentBlockHash,
    randomSeed,
  };
}

function createSessionProof({ sessionId, challengeHash, startTime, endTime, wallet, heartbeatCount, nonce }) {
  const proofHash = buildProofHash({
    sessionId,
    challengeHash,
    startTime,
    endTime,
    wallet,
    heartbeatCount,
    nonce,
  });

  return {
    proofHash,
    validatorSignature: signValidatorProof(proofHash),
  };
}

module.exports = {
  buildChallengeHash,
  buildProofHash,
  buildValidatorCandidateState,
  createSessionChallenge,
  createSessionProof,
  fetchCurrentBlockHash,
  signValidatorProof,
  verifyValidatorSignature,
};
