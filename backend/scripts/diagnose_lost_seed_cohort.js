/**
 * READ-ONLY diagnostic — measures the "lost server seed" cohort and its
 * financial exposure, so we can decide how risky a consent-based wallet
 * recovery would be.
 *
 * Does NOT write anything. Safe to run in production.
 *
 * For every user that has server-side seed ciphertext, it tries to decrypt
 * with all known keys (v2 + v1 + interim, via decryptSecretEx). It then
 * buckets the FAILING cohort by:
 *   - custodial balance (users.ants_balance / ant_balance) — this ALWAYS
 *     survives a new wallet because it is keyed to the user/email row.
 *   - potential on-chain exposure: only wallets with total_sessions >= 1000
 *     can ever have been ACTIVATED on L1 and thus hold on-chain coins that a
 *     new address could NOT recover. This is our upper-bound proxy.
 *
 * Run in the Render Shell (~/project/src/backend):
 *   node scripts/diagnose_lost_seed_cohort.js
 *
 * Optional: limit the scan for a fast sample:
 *   node scripts/diagnose_lost_seed_cohort.js --limit 5000
 */

require('dotenv').config();
const { Pool } = require('pg');
const { decryptSecretEx } = require('../utils/cryptoVault');

const MIN_SESSIONS_FOR_ANET = 1000;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i === process.argv.length - 1) return fallback;
  return process.argv[i + 1];
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const limit = parseInt(argValue('--limit', '0'), 10) || 0;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const sql = `
    SELECT id,
           wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag, wallet_seed_key_version,
           COALESCE(GREATEST(COALESCE(ants_balance, 0), COALESCE(ant_balance, 0)), 0) AS custodial_ants,
           COALESCE(total_sessions, 0) AS total_sessions
    FROM users
    WHERE wallet_seed_encrypted IS NOT NULL
      AND wallet_seed_iv IS NOT NULL
      AND wallet_seed_tag IS NOT NULL
      AND COALESCE(is_deleted, FALSE) = FALSE
    ORDER BY id
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `;

  const { rows } = await pool.query(sql);

  const stats = {
    scanned: rows.length,
    decrypt_ok: 0,
    decrypt_fail: 0,
    // Among the FAILING (lost-seed) cohort:
    fail_custodial_zero: 0,
    fail_custodial_nonzero: 0,
    fail_custodial_ants_total: 0,
    fail_activated_potential_onchain: 0, // total_sessions >= 1000
    fail_not_activated: 0,
  };

  for (const r of rows) {
    let ok = false;
    try {
      const dec = decryptSecretEx(
        r.wallet_seed_encrypted,
        r.wallet_seed_iv,
        r.wallet_seed_tag,
        r.wallet_seed_key_version
      );
      const words = String(dec.plaintext || '').trim().split(/\s+/);
      ok = words.length >= 12 || String(dec.plaintext || '').startsWith('evmkey:');
    } catch (_) {
      ok = false;
    }

    if (ok) {
      stats.decrypt_ok += 1;
      continue;
    }

    stats.decrypt_fail += 1;
    const custodial = Number(r.custodial_ants || 0);
    if (custodial > 0) {
      stats.fail_custodial_nonzero += 1;
      stats.fail_custodial_ants_total += custodial;
    } else {
      stats.fail_custodial_zero += 1;
    }

    if (Number(r.total_sessions || 0) >= MIN_SESSIONS_FOR_ANET) {
      stats.fail_activated_potential_onchain += 1;
    } else {
      stats.fail_not_activated += 1;
    }
  }

  const pct = (n) =>
    stats.decrypt_fail > 0 ? ((n / stats.decrypt_fail) * 100).toFixed(1) : '0.0';

  console.log('\n===== LOST-SEED COHORT DIAGNOSTIC (read-only) =====');
  console.log(`scanned rows with seed ciphertext : ${stats.scanned}`);
  console.log(`  decrypt OK (healthy)            : ${stats.decrypt_ok}`);
  console.log(`  decrypt FAIL (lost server seed) : ${stats.decrypt_fail}`);
  console.log('\n--- of the FAILING cohort ---');
  console.log(`  custodial balance = 0           : ${stats.fail_custodial_zero} (${pct(stats.fail_custodial_zero)}%)`);
  console.log(`  custodial balance > 0           : ${stats.fail_custodial_nonzero} (${pct(stats.fail_custodial_nonzero)}%)`);
  console.log(`  custodial ANTS at stake (safe)  : ${stats.fail_custodial_ants_total}`);
  console.log('\n--- potential ON-CHAIN exposure (unrecoverable if seed gone) ---');
  console.log(`  activated (sessions >= ${MIN_SESSIONS_FOR_ANET})    : ${stats.fail_activated_potential_onchain} (${pct(stats.fail_activated_potential_onchain)}%)  <-- need LOUD on-chain warning`);
  console.log(`  not activated (no on-chain coins): ${stats.fail_not_activated} (${pct(stats.fail_not_activated)}%)  <-- clean to recover`);
  console.log('==================================================\n');

  await pool.end();
})().catch((err) => {
  console.error('[diagnose_lost_seed_cohort] error:', err);
  process.exit(1);
});
