#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * snapshot_l1_genesis.js — REVELATION BLOCK 0
 *
 * Builds a deterministic, signature-anchored genesis state file for the
 * A-Network Layer 1 chain.
 *
 * Inputs (env):
 *   DATABASE_URL                   — Postgres connection (production)
 *   GENESIS_SIGNER_KEY (optional)  — hex 32-byte ed25519 seed for signing
 *                                    (if absent, the script outputs an
 *                                    unsigned snapshot + a SHA-256 root
 *                                    hash you can sign offline)
 *   GENESIS_MESSAGE (optional)     — override the embedded revelation text
 *   OUT_DIR (optional)             — output directory (default: ./genesis)
 *   SKIP_CHAIN_ANCHORS=1           — skip live BTC/BSC block fetches
 *
 * Outputs:
 *   genesis/genesis.json    — canonical deterministic JSON
 *   genesis/genesis.sha256  — sha256 of genesis.json
 *   genesis/genesis.sig     — ed25519 sig over the sha256 (if signer present)
 *   genesis/manifest.txt    — human-readable summary
 *
 * Economics (mirror of services/miningEngine.js):
 *   1 ANET = 100,000,000 ANTS
 *   Launch tranche: first 500,000 network sessions @ 0.04882812 ANET/session
 *   Stage 0 base:    0.00262144 ANET/session, halving every 3.8B sessions
 *   Hard cap:        21,000,000 ANET
 *
 * For genesis we use the **on-ledger ants_balance** as the source of truth
 * for each user. We then independently recompute the theoretical balance
 * from `successful_sessions` and emit any drift in `audit.balance_drift`
 * so third parties can verify the ledger before signing off.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Economics — kept in sync with backend/services/miningEngine.js
// ---------------------------------------------------------------------------
const ANTS_PER_ANET = 100_000_000n;
const MAX_SUPPLY_ANET = 21_000_000n;
const MAX_SUPPLY_ANTS = MAX_SUPPLY_ANET * ANTS_PER_ANET;
const LAUNCH_TRANCHE_SESSIONS = 500_000n;
const LAUNCH_REWARD_ANTS = 4_882_812n;          // 0.04882812 ANET
const BASE_REWARD_ANTS = 262_144n;              // 0.00262144 ANET (stage 0)
const HALVING_INTERVAL = 3_800_000_000n;
const MAX_HALVING_STAGE = 9n;
const ELIGIBILITY_THRESHOLD = 1_000n;

function rewardAntsForSessionIndex(idx /* 1-based */) {
  if (idx <= LAUNCH_TRANCHE_SESSIONS) return LAUNCH_REWARD_ANTS;
  const post = idx - LAUNCH_TRANCHE_SESSIONS - 1n;
  let stage = post / HALVING_INTERVAL;
  if (stage > MAX_HALVING_STAGE) stage = MAX_HALVING_STAGE;
  return BASE_REWARD_ANTS / (2n ** stage);
}

/**
 * Compute the theoretical ANTS balance a user would have, assuming they
 * mined sessions [k+1 .. k+N] where k = network sessions before this user's
 * activity began. For a deterministic genesis we cannot know k per-user,
 * so we use the *user-local* schedule: their own first 500K sessions get
 * the launch reward, then halving by their own session count. This matches
 * the per-user policy enforced by miningEngine.calculateRewardAnts which
 * also keys off the user's `total_sessions`.
 */
function theoreticalAntsForUser(successfulSessions) {
  const n = BigInt(successfulSessions || 0);
  if (n <= 0n) return 0n;

  let total = 0n;

  // Launch tranche segment
  const launchPart = n < LAUNCH_TRANCHE_SESSIONS ? n : LAUNCH_TRANCHE_SESSIONS;
  total += launchPart * LAUNCH_REWARD_ANTS;

  if (n <= LAUNCH_TRANCHE_SESSIONS) return total;

  // Post-launch halving segments
  let remaining = n - LAUNCH_TRANCHE_SESSIONS;
  let stage = 0n;
  while (remaining > 0n && stage <= MAX_HALVING_STAGE) {
    const take = remaining < HALVING_INTERVAL ? remaining : HALVING_INTERVAL;
    const reward = BASE_REWARD_ANTS / (2n ** stage);
    total += take * reward;
    remaining -= take;
    stage += 1n;
  }

  // Anything past max stage continues at the final stage rate
  if (remaining > 0n) {
    const reward = BASE_REWARD_ANTS / (2n ** MAX_HALVING_STAGE);
    total += remaining * reward;
  }

  return total;
}

// ---------------------------------------------------------------------------
// Live chain anchors — sealed into the genesis file as proof-of-time
// ---------------------------------------------------------------------------
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'anet-genesis/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Non-JSON response from ${url}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`Timeout: ${url}`)));
  });
}

async function fetchChainAnchors() {
  if (process.env.SKIP_CHAIN_ANCHORS === '1') {
    return { skipped: true };
  }
  const anchors = {};

  // Bitcoin head
  try {
    const tip = await httpGetJson('https://mempool.space/api/blocks/tip/height');
    const hash = await httpGetJson('https://mempool.space/api/blocks/tip/hash')
      .catch(() => null);
    anchors.bitcoin = {
      height: Number(tip),
      hash: typeof hash === 'string' ? hash : null,
      source: 'mempool.space',
    };
  } catch (e) {
    anchors.bitcoin_error = String(e.message || e);
  }

  // BNB Smart Chain head (public RPC, no key required)
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [],
    });
    const res = await new Promise((resolve, reject) => {
      const req = https.request(
        'https://bsc-dataseed1.binance.org/',
        { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } },
        (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        },
      );
      req.on('error', reject);
      req.setTimeout(15_000, () => req.destroy(new Error('BSC RPC timeout')));
      req.write(body); req.end();
    });
    anchors.bsc = {
      height: parseInt(res.result, 16),
      source: 'bsc-dataseed1.binance.org',
    };
  } catch (e) {
    anchors.bsc_error = String(e.message || e);
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// Canonical JSON — keys sorted, no whitespace; BigInts emitted as strings
// ---------------------------------------------------------------------------
function canonicalize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  throw new Error(`Unserializable type: ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const REVELATION_MESSAGE =
    process.env.GENESIS_MESSAGE ||
    'REVELATION BLOCK 0 — WEF Agenda 2030 sealed into Proof-of-Work time. No authority. No reversal. No governance. Truth revealed by computation.';

  const outDir = path.resolve(process.env.OUT_DIR || path.join(__dirname, '..', 'genesis'));
  fs.mkdirSync(outDir, { recursive: true });

  console.log('==> Fetching live chain anchors...');
  const anchors = await fetchChainAnchors();
  console.log('    anchors:', JSON.stringify(anchors));

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
  });

  console.log('==> Reading eligible users from Postgres...');
  const { rows } = await pool.query(`
    SELECT
      id,
      LOWER(COALESCE(custom_wallet_address, wallet_address, '')) AS wallet,
      COALESCE(successful_sessions, 0)::bigint AS sessions,
      COALESCE(ants_balance, 0)::bigint        AS ants,
      COALESCE(claimed_anet, 0)::numeric       AS claimed,
      COALESCE(email_verified, false)          AS verified,
      EXTRACT(EPOCH FROM created_at)::bigint   AS created_unix
    FROM users
    WHERE COALESCE(is_deleted, FALSE) = FALSE
      AND COALESCE(successful_sessions, 0) > 0
    ORDER BY wallet ASC, id ASC
  `);

  console.log(`    pulled ${rows.length} active mining accounts`);

  // ---------- Aggregate by wallet (dedupe multi-account same wallet) -------
  const byWallet = new Map();
  let totalLedgerAnts = 0n;
  let totalTheoreticalAnts = 0n;
  let totalSessions = 0n;
  let eligibleCount = 0;
  let unverifiedCount = 0;
  let walletlessAccounts = 0;

  for (const r of rows) {
    const sessions = BigInt(r.sessions);
    const ledgerAnts = BigInt(r.ants);
    const theoryAnts = theoreticalAntsForUser(sessions);

    totalSessions += sessions;
    totalLedgerAnts += ledgerAnts;
    totalTheoreticalAnts += theoryAnts;
    if (sessions >= ELIGIBILITY_THRESHOLD) eligibleCount += 1;
    if (!r.verified) unverifiedCount += 1;

    if (!r.wallet) { walletlessAccounts += 1; continue; }

    const cur = byWallet.get(r.wallet) || {
      wallet: r.wallet,
      account_ids: [],
      sessions: 0n,
      ants_ledger: 0n,
      ants_theoretical: 0n,
      first_seen_unix: Number(r.created_unix) || 0,
      verified: false,
    };
    cur.account_ids.push(String(r.id));
    cur.sessions += sessions;
    cur.ants_ledger += ledgerAnts;
    cur.ants_theoretical += theoryAnts;
    cur.verified = cur.verified || !!r.verified;
    if (r.created_unix && (!cur.first_seen_unix || r.created_unix < cur.first_seen_unix)) {
      cur.first_seen_unix = Number(r.created_unix);
    }
    byWallet.set(r.wallet, cur);
  }

  // Supply cap enforcement
  if (totalLedgerAnts > MAX_SUPPLY_ANTS) {
    throw new Error(
      `Ledger total ${totalLedgerAnts} exceeds hard cap ${MAX_SUPPLY_ANTS} — refusing to mint genesis`,
    );
  }

  // Deterministic ordered allocations
  const allocations = [...byWallet.values()]
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
    .map((w) => ({
      wallet: w.wallet,
      sessions: w.sessions,
      ants: w.ants_ledger,                    // canonical genesis balance
      ants_theoretical: w.ants_theoretical,
      ants_drift: w.ants_ledger - w.ants_theoretical,
      eligible: w.sessions >= ELIGIBILITY_THRESHOLD,
      verified: w.verified,
      account_count: w.account_ids.length,
      first_seen_unix: w.first_seen_unix,
    }));

  // ---------- Build canonical genesis object ------------------------------
  const nowUnix = Math.floor(Date.now() / 1000);

  const genesis = {
    chain: 'a-network',
    chain_id: 'anet-mainnet-1',
    name: 'REVELATION BLOCK 0',
    spec_version: 1,
    height: 0,
    parent_hash: '0x' + '00'.repeat(32),
    timestamp_unix: nowUnix,
    timestamp_iso: new Date(nowUnix * 1000).toISOString(),
    message: REVELATION_MESSAGE,
    economics: {
      ants_per_anet: ANTS_PER_ANET.toString(),
      max_supply_anet: MAX_SUPPLY_ANET.toString(),
      max_supply_ants: MAX_SUPPLY_ANTS.toString(),
      launch_tranche_sessions: LAUNCH_TRANCHE_SESSIONS.toString(),
      launch_reward_ants: LAUNCH_REWARD_ANTS.toString(),
      base_reward_ants: BASE_REWARD_ANTS.toString(),
      halving_interval: HALVING_INTERVAL.toString(),
      max_halving_stage: MAX_HALVING_STAGE.toString(),
      eligibility_threshold_sessions: ELIGIBILITY_THRESHOLD.toString(),
    },
    chain_anchors: anchors,
    audit: {
      source_rows: rows.length,
      walletless_accounts: walletlessAccounts,
      unique_wallets: allocations.length,
      eligible_accounts: eligibleCount,
      unverified_accounts: unverifiedCount,
      total_sessions: totalSessions,
      total_ants_ledger: totalLedgerAnts,
      total_ants_theoretical: totalTheoreticalAnts,
      total_ants_drift: totalLedgerAnts - totalTheoreticalAnts,
    },
    allocations,
  };

  // ---------- Serialize, hash, write --------------------------------------
  const canonical = canonicalize(genesis);
  // File on disk MUST equal the hashed bytes exactly so anyone running
  // `shasum -a 256 genesis.json` reproduces the committed hash.
  const canonicalBytes = Buffer.from(canonical, 'utf8');
  const sha256 = crypto.createHash('sha256').update(canonicalBytes).digest('hex');

  fs.writeFileSync(path.join(outDir, 'genesis.json'), canonicalBytes);
  fs.writeFileSync(path.join(outDir, 'genesis.sha256'), sha256 + '  genesis.json\n');

  let signaturePath = null;
  const signerHex = (process.env.GENESIS_SIGNER_KEY || '').trim();
  if (signerHex) {
    try {
      const seed = Buffer.from(signerHex.replace(/^0x/, ''), 'hex');
      if (seed.length !== 32) throw new Error('GENESIS_SIGNER_KEY must be 32 bytes hex');
      const keyObj = crypto.createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS#8 ed25519 header
          seed,
        ]),
        format: 'der',
        type: 'pkcs8',
      });
      const sig = crypto.sign(null, Buffer.from(sha256, 'hex'), keyObj);
      signaturePath = path.join(outDir, 'genesis.sig');
      fs.writeFileSync(signaturePath, sig.toString('hex') + '\n');
      const pubDer = crypto.createPublicKey(keyObj).export({ format: 'der', type: 'spki' });
      const pubHex = pubDer.slice(-32).toString('hex');
      fs.writeFileSync(path.join(outDir, 'genesis.pubkey'), pubHex + '\n');
    } catch (e) {
      console.warn('!! Signing failed:', e.message);
    }
  }

  // ---------- Human-readable manifest -------------------------------------
  const fmt = (b) => `${(Number(b) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} ANET (${b.toString()} ANTS)`;
  const manifest = [
    '====================================================================',
    '  A-NETWORK — REVELATION BLOCK 0',
    '====================================================================',
    '',
    `  Message       : ${REVELATION_MESSAGE}`,
    `  Timestamp     : ${genesis.timestamp_iso}`,
    `  SHA-256 root  : ${sha256}`,
    signaturePath ? `  Signature     : ${path.basename(signaturePath)} (ed25519)` : '  Signature     : (none — set GENESIS_SIGNER_KEY to sign)',
    '',
    '  Chain anchors:',
    `    Bitcoin head : ${anchors.bitcoin ? `#${anchors.bitcoin.height}  ${anchors.bitcoin.hash || ''}` : '(unavailable)'}`,
    `    BSC head     : ${anchors.bsc ? `#${anchors.bsc.height}` : '(unavailable)'}`,
    '',
    '  Aggregate state:',
    `    Source rows           : ${rows.length}`,
    `    Unique wallets        : ${allocations.length}`,
    `    Walletless accounts   : ${walletlessAccounts}`,
    `    Eligible accounts     : ${eligibleCount}  (>= ${ELIGIBILITY_THRESHOLD} sessions)`,
    `    Unverified accounts   : ${unverifiedCount}`,
    `    Total sessions        : ${totalSessions.toString()}`,
    `    Total ledger balance  : ${fmt(totalLedgerAnts)}`,
    `    Theoretical balance   : ${fmt(totalTheoreticalAnts)}`,
    `    Ledger / theory drift : ${(totalLedgerAnts - totalTheoreticalAnts).toString()} ANTS`,
    `    Hard cap headroom     : ${fmt(MAX_SUPPLY_ANTS - totalLedgerAnts)}`,
    '',
    '  Output files:',
    `    ${path.join(outDir, 'genesis.json')}`,
    `    ${path.join(outDir, 'genesis.sha256')}`,
    signaturePath ? `    ${signaturePath}` : '',
    signaturePath ? `    ${path.join(outDir, 'genesis.pubkey')}` : '',
    '',
    '  Publish the SHA-256 root publicly (X / Telegram / GitHub release).',
    '  Once posted, the genesis state is timestamp-committed and cannot be',
    '  silently altered. No authority. No reversal. Truth by computation.',
    '====================================================================',
    '',
  ].filter(Boolean).join('\n');

  fs.writeFileSync(path.join(outDir, 'manifest.txt'), manifest);
  console.log('\n' + manifest);

  await pool.end();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
