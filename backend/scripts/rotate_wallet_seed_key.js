#!/usr/bin/env node
/**
 * rotate_wallet_seed_key.js
 *
 * Re-encrypts every users.wallet_seed_encrypted row from the legacy key (v1)
 * to the new key (v2). Idempotent and resumable — re-running picks up where
 * a previous run left off because v2 rows are excluded from the work set.
 *
 * REQUIRED ENV
 *   DATABASE_URL                          Postgres connection string
 *   WALLET_SEED_ENCRYPTION_KEY            New 64-char hex key (32 bytes)
 *   WALLET_SEED_ENCRYPTION_KEY_V1         Legacy key (passphrase OR 64-hex)
 *
 * USAGE
 *   node backend/scripts/rotate_wallet_seed_key.js --dry-run    # no writes
 *   node backend/scripts/rotate_wallet_seed_key.js              # live run
 *
 * SAFETY
 *   - Per-row UPDATE; no big transaction; safe to interrupt with Ctrl-C.
 *   - Verifies derived ANET address matches users.custom_wallet_address before
 *     re-encrypting; mismatches are logged and skipped (never overwritten).
 *   - Refuses to run if v1 == v2.
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const { generateCustomWalletAddress } = require('../utils/walletUtils');

const ALGO = 'aes-256-gcm';
const BATCH_SIZE = Number(process.env.ROTATE_BATCH_SIZE) || 500;
const PROGRESS_EVERY = 1000;

function readKey(envName, { allowPassphrase }) {
  const raw = String(process.env[envName] || '').trim();
  if (!raw) throw new Error(`Missing ${envName}`);
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (!allowPassphrase) {
    throw new Error(`${envName} must be 64-character hex (32 bytes).`);
  }
  return crypto.createHash('sha256').update(raw).digest();
}

function decryptWithKey(key, encrypted, iv, tag) {
  const decipher = crypto.createDecipheriv(
    ALGO,
    key,
    Buffer.from(String(iv || ''), 'base64')
  );
  decipher.setAuthTag(Buffer.from(String(tag || ''), 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(String(encrypted || ''), 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

function encryptWithKey(key, plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText || ''), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');

  const oldKey = readKey('WALLET_SEED_ENCRYPTION_KEY_V1', { allowPassphrase: true });
  const newKey = readKey('WALLET_SEED_ENCRYPTION_KEY', { allowPassphrase: false });
  if (oldKey.equals(newKey)) {
    throw new Error('WALLET_SEED_ENCRYPTION_KEY and _V1 are identical — refusing to run.');
  }
  // v1.5 — rows written during the deploy window when the NEW hex env value
  // was set, but the OLD cryptoVault.js (which did sha256(envValue) regardless
  // of format) was still running. The actual AES key was sha256("<hex>"), not
  // Buffer.from(hex, 'hex'). Affects sign-ups between env-rotate and code deploy.
  const interimKey = crypto
    .createHash('sha256')
    .update(String(process.env.WALLET_SEED_ENCRYPTION_KEY || '').trim())
    .digest();

  if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`[rotate] DRY_RUN=${DRY_RUN} BATCH_SIZE=${BATCH_SIZE}`);
  console.log('[rotate] Ensuring wallet_seed_key_version column exists...');
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS wallet_seed_key_version SMALLINT
  `);

  const startTotal = (await pool.query(`
    SELECT COUNT(*)::int AS n
    FROM users
    WHERE wallet_seed_encrypted IS NOT NULL
      AND (wallet_seed_key_version IS NULL OR wallet_seed_key_version = 1)
  `)).rows[0].n;
  console.log(`[rotate] Rows to migrate: ${startTotal}`);
  if (startTotal === 0) {
    console.log('[rotate] Nothing to do.');
    await pool.end();
    return;
  }

  let processed = 0;
  let migrated = 0;
  let mismatched = 0;
  let failed = 0;
  let interimRewritten = 0;
  let lastId = 0;
  const t0 = Date.now();

  // Keyset pagination by id ASC. Because the WHERE clause excludes already-v2
  // rows, every migrated row drops out of the window automatically, so we can
  // safely keep advancing lastId without losing anything.
  while (true) {
    const batch = await pool.query(
      `
      SELECT id, custom_wallet_address,
             wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag
      FROM users
      WHERE wallet_seed_encrypted IS NOT NULL
        AND (wallet_seed_key_version IS NULL OR wallet_seed_key_version = 1)
        AND id > $1
      ORDER BY id ASC
      LIMIT $2
      `,
      [lastId, BATCH_SIZE]
    );
    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      lastId = row.id;
      processed += 1;

      // Path A: try v1 (legacy placeholder) decrypt → re-encrypt with v2.
      // Path B: if v1 fails, try v2 — the row was already written with the new
      //         key by the live app (typical for sign-ups that happened after
      //         the env rotation AND after the new cryptoVault deployed).
      // Path C: if v2 fails, try the "interim" key sha256(envHexString). Rows
      //         written during the deploy window were encrypted with this key
      //         because the OLD cryptoVault was still running while the NEW
      //         env value was already set. We must re-encrypt those with the
      //         proper v2 key bytes.
      let seed = null;
      let alreadyV2 = false;
      let usedInterim = false;
      try {
        seed = decryptWithKey(
          oldKey,
          row.wallet_seed_encrypted,
          row.wallet_seed_iv,
          row.wallet_seed_tag
        );
      } catch (_) {
        try {
          seed = decryptWithKey(
            newKey,
            row.wallet_seed_encrypted,
            row.wallet_seed_iv,
            row.wallet_seed_tag
          );
          alreadyV2 = true;
        } catch (_err2) {
          try {
            seed = decryptWithKey(
              interimKey,
              row.wallet_seed_encrypted,
              row.wallet_seed_iv,
              row.wallet_seed_tag
            );
            usedInterim = true;
          } catch (err3) {
            failed += 1;
            console.error(
              `[rotate] user ${row.id}: decrypt failed with v1, v2, AND interim keys: ${err3.message}`
            );
            continue;
          }
        }
      }

      if (row.custom_wallet_address) {
        const derived = generateCustomWalletAddress(seed);
        if (derived !== row.custom_wallet_address) {
          mismatched += 1;
          console.warn(
            `[rotate] user ${row.id}: address mismatch ` +
              `(stored=${row.custom_wallet_address} derived=${derived}) — skipping`
          );
          continue;
        }
      }

      if (alreadyV2) {
        // Ciphertext already current; just stamp the version flag.
        if (!DRY_RUN) {
          await pool.query(
            `UPDATE users SET wallet_seed_key_version = 2 WHERE id = $1`,
            [row.id]
          );
        }
        migrated += 1;
        if (processed % PROGRESS_EVERY === 0) {
          const rate = processed / ((Date.now() - t0) / 1000);
          console.log(
            `[rotate] processed=${processed} migrated=${migrated} ` +
              `mismatched=${mismatched} failed=${failed} ` +
              `rate=${rate.toFixed(0)}/s lastId=${lastId}`
          );
        }
        continue;
      }

      if (usedInterim) {
        interimRewritten += 1;
        console.log(`[rotate] user ${row.id}: decrypted with interim key — re-encrypting with v2.`);
      }

      const fresh = encryptWithKey(newKey, seed);

      if (!DRY_RUN) {
        await pool.query(
          `
          UPDATE users
             SET wallet_seed_encrypted   = $1,
                 wallet_seed_iv          = $2,
                 wallet_seed_tag         = $3,
                 wallet_seed_key_version = 2
           WHERE id = $4
          `,
          [fresh.encrypted, fresh.iv, fresh.tag, row.id]
        );
      }
      migrated += 1;

      if (processed % PROGRESS_EVERY === 0) {
        const rate = processed / ((Date.now() - t0) / 1000);
        console.log(
          `[rotate] processed=${processed} migrated=${migrated} ` +
            `mismatched=${mismatched} failed=${failed} ` +
            `rate=${rate.toFixed(0)}/s lastId=${lastId}`
        );
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('[rotate] -------- DONE --------');
  console.log(`[rotate] processed:  ${processed}`);
  console.log(`[rotate] migrated:   ${migrated}`);
  console.log(`[rotate] interim:    ${interimRewritten}`);
  console.log(`[rotate] mismatched: ${mismatched}`);
  console.log(`[rotate] failed:     ${failed}`);
  console.log(`[rotate] elapsed:    ${elapsed}s`);
  if (DRY_RUN) console.log('[rotate] DRY_RUN — no rows were updated.');

  await pool.end();
}

main().catch((err) => {
  console.error('[rotate] fatal:', err);
  process.exit(1);
});
