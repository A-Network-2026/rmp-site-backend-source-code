/**
 * create_reviewer_accounts_with_sessions.js
 * Creates 2 reviewer accounts with 1000 sessions completed for testing.
 *
 * Usage:
 *   node scripts/create_reviewer_accounts_with_sessions.js
 */

require('dotenv').config();
const db = require('../db');
const bcrypt = require('bcryptjs');

// ── Reviewer credentials ──────────────────────────────────────────────────────
const REVIEWERS = [
  {
    email: 'reviewer1@a-network.net',
    password: 'ReviewAnet2026!',
    deviceId: 'play-review-device-001',
    wallet: 'ANET_REVIEWER_1000_SESSIONS_0001',
  },
  {
    email: 'reviewer2@a-network.net',
    password: 'ReviewAnet2026!',
    deviceId: 'play-review-device-002',
    wallet: 'ANET_REVIEWER_1000_SESSIONS_0002',
  },
];

async function main() {
  console.log('Creating 2 reviewer accounts with 1000 sessions each...\n');

  for (const reviewer of REVIEWERS) {
    const passwordHash = await bcrypt.hash(reviewer.password, 12);

    const result = await db.query(
      `INSERT INTO users (
         email,
         password,
         email_verified,
         device_id,
         wallet_address,
         is_mining,
         preferred_language,
         total_sessions,
         successful_sessions,
         session_end_time
       )
       VALUES ($1, $2, TRUE, $3, $4, FALSE, 'en', 1000, 1000, NOW())
       ON CONFLICT (email) DO UPDATE
         SET password        = EXCLUDED.password,
             email_verified  = TRUE,
             device_id       = EXCLUDED.device_id,
             wallet_address  = COALESCE(users.wallet_address, EXCLUDED.wallet_address),
             preferred_language = 'en',
             total_sessions  = 1000,
             successful_sessions = 1000,
             session_end_time = NOW()
       RETURNING id, email, email_verified, device_id, wallet_address, total_sessions, successful_sessions`,
      [reviewer.email, passwordHash, reviewer.deviceId, reviewer.wallet]
    );

    const row = result.rows[0];
    console.log(`✅ Reviewer account created/updated:`);
    console.log(`   ID              : ${row.id}`);
    console.log(`   Email           : ${row.email}`);
    console.log(`   Verified        : ${row.email_verified}`);
    console.log(`   Device ID       : ${row.device_id}`);
    console.log(`   Wallet          : ${row.wallet_address}`);
    console.log(`   Total Sessions  : ${row.total_sessions}`);
    console.log(`   Successful Sessions : ${row.successful_sessions}`);
    // Password intentionally omitted from logs — retrieve from source configuration.
    console.log('');
  }

  console.log('── Test Credentials ──────────────────────────────────────────');
  REVIEWERS.forEach((r, i) => {
    console.log(`Reviewer ${i + 1}:`);
    console.log(`   Email    : ${r.email}`);
    console.log(`   Password : ${r.password}`);
    console.log(`   Status   : ✅ 1000 sessions completed - ALL FEATURES UNLOCKED`);
    console.log('');
  });
  console.log('──────────────────────────────────────────────────────────────');

  await db.end ? db.end() : process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to create reviewer accounts:', err.message);
  process.exit(1);
});
