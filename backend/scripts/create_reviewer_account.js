/**
 * create_reviewer_account.js
 * Creates (or upserts) a permanent Google Play reviewer account.
 *
 * Usage:
 *   node scripts/create_reviewer_account.js
 *
 * Run this once against the production database.
 * The credentials produced here must be entered into Play Console:
 *   App content → App access → Add new instructions
 */

require('dotenv').config();
const db = require('../db');
const bcrypt = require('bcryptjs');

// ── Reviewer credentials ──────────────────────────────────────────────────────
const REVIEWER_EMAIL    = 'reviewer@a-network.net';
const REVIEWER_PASSWORD = 'ReviewAnet2026!';   // change after review period ends
const REVIEWER_DEVICE_ID  = 'play-review-device-001';
// A dummy ANET wallet address so the wallet guard in /start is satisfied
const REVIEWER_WALLET     = 'ANET_REVIEWER_000000000000000001';
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const passwordHash = await bcrypt.hash(REVIEWER_PASSWORD, 12);

  const result = await db.query(
    `INSERT INTO users (
       email,
       password,
       email_verified,
       device_id,
       wallet_address,
       is_mining,
       preferred_language
     )
     VALUES ($1, $2, TRUE, $3, $4, FALSE, 'en')
     ON CONFLICT (email) DO UPDATE
       SET password        = EXCLUDED.password,
           email_verified  = TRUE,
           device_id       = EXCLUDED.device_id,
           wallet_address  = COALESCE(users.wallet_address, EXCLUDED.wallet_address),
           preferred_language = 'en'
     RETURNING id, email, email_verified, device_id, wallet_address`,
    [REVIEWER_EMAIL, passwordHash, REVIEWER_DEVICE_ID, REVIEWER_WALLET]
  );

  const row = result.rows[0];
  console.log('✅ Reviewer account ready:');
  console.log('   ID            :', row.id);
  console.log('   Email         :', row.email);
  console.log('   email_verified:', row.email_verified);
  console.log('   device_id     :', row.device_id);
  console.log('   wallet_address:', row.wallet_address);
  console.log('');
  console.log('── Play Console App Access form ──────────────────────────────');
  console.log('   Instruction name : Google Play Reviewer');
  console.log('   Username / Email :', REVIEWER_EMAIL);
  // Password intentionally omitted from logs — retrieve from env or secure vault.
  console.log('   Additional notes : No OTP required. Account is pre-verified.');
  console.log('                      All mining and wallet features are accessible.');
  console.log('──────────────────────────────────────────────────────────────');

  await db.end ? db.end() : process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to create reviewer account:', err.message);
  process.exit(1);
});
