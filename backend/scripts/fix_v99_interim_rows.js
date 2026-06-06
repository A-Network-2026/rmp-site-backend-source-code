/**
 * One-off fix for users.wallet_seed_key_version = 99 rows.
 * See header comment in original; this file uses Pool which was
 * confirmed working against Render Postgres earlier.
 */

require('dotenv').config();
const { Pool } = require('pg');
const {
  decryptSecretEx,
  encryptSecret,
} = require('../utils/cryptoVault');

const APPLY = process.argv.includes('--apply');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL'); process.exit(1);
  }
  if (!process.env.WALLET_SEED_ENCRYPTION_KEY) {
    console.error('Missing WALLET_SEED_ENCRYPTION_KEY'); process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows } = await pool.query(`
    SELECT id, email,
           wallet_seed_encrypted, wallet_seed_iv, wallet_seed_tag
    FROM users
    WHERE wallet_seed_key_version = 99
      AND wallet_seed_encrypted IS NOT NULL
    ORDER BY id
  `);

  console.log(`[fix_v99] mode=${APPLY ? 'APPLY' : 'DRY_RUN'} v1_set=${!!process.env.WALLET_SEED_ENCRYPTION_KEY_V1} rows=${rows.length}`);

  let ok = 0, failed = 0;
  for (const r of rows) {
    try {
      const dec = decryptSecretEx(
        r.wallet_seed_encrypted, r.wallet_seed_iv, r.wallet_seed_tag, 99
      );
      const words = String(dec.plaintext || '').trim().split(/\s+/);
      if (words.length < 12) {
        throw new Error(`decrypted but only ${words.length} words`);
      }
      if (APPLY) {
        const fresh = encryptSecret(dec.plaintext);
        await pool.query(
          `UPDATE users
             SET wallet_seed_encrypted   = $1,
                 wallet_seed_iv          = $2,
                 wallet_seed_tag         = $3,
                 wallet_seed_key_version = 2,
                 updated_at              = NOW()
           WHERE id = $4`,
          [fresh.encrypted, fresh.iv, fresh.tag, r.id]
        );
      }
      ok++;
      console.log(`[fix_v99] user=${r.id} email=${r.email} decryptedVia=${dec.keyVersionUsed} words=${words.length} ${APPLY ? 'migrated' : 'would migrate'}`);
    } catch (e) {
      failed++;
      console.error(`[fix_v99] user=${r.id} email=${r.email} FAILED: ${e.message}`);
    }
  }

  console.log(`[fix_v99] done. ok=${ok} failed=${failed} total=${rows.length}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
