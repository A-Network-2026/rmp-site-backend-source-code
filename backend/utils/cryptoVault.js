const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY_VERSION_CURRENT = 2;

/**
 * Read a 32-byte AES key from env. Must be 64-character hex unless
 * allowPassphrase=true (legacy v1 path, where the env value was an
 * arbitrary string we SHA-256 hashed into a key).
 */
function readEnvKey(envName, { allowPassphrase = false } = {}) {
  const raw = String(process.env[envName] || '').trim();
  if (!raw) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (allowPassphrase) {
    return crypto.createHash('sha256').update(raw).digest();
  }
  throw new Error(
    `${envName} must be a 64-character hex string (32 bytes). ` +
    `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  );
}

function getKeyV2() {
  const k = readEnvKey('WALLET_SEED_ENCRYPTION_KEY');
  if (!k) throw new Error('Missing WALLET_SEED_ENCRYPTION_KEY environment variable');
  return k;
}

/**
 * Legacy key: SHA-256(WALLET_SEED_ENCRYPTION_KEY_V1). Used to decrypt rows
 * that were encrypted with the original placeholder passphrase
 * ("your_super_secret_32_char_key") before the v2 rotation. Returns null
 * if the env var is unset — callers must handle that.
 */
function getKeyV1() {
  return readEnvKey('WALLET_SEED_ENCRYPTION_KEY_V1', { allowPassphrase: true });
}

/**
 * "Interim" key: SHA-256(WALLET_SEED_ENCRYPTION_KEY). Reproduces the bug
 * window where the env value was rotated to a 64-hex string BUT the old
 * cryptoVault code (which always hashed the env value regardless of
 * format) was still running. Rows written during that window are
 * encrypted with sha256("<hex string>"), not Buffer.from(hex, 'hex').
 */
function getKeyInterim() {
  const raw = String(process.env.WALLET_SEED_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

function tryDecryptWithKey(key, encrypted, iv, tag) {
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

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const key = getKeyV2();
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
    keyVersion: KEY_VERSION_CURRENT,
  };
}

/**
 * Decrypt a seed ciphertext. Tries v2 first (the current key), then
 * falls back to the legacy v1 placeholder key, then to the deploy-window
 * "interim" key (sha256 of the hex env value). On success, returns
 * { plaintext, keyVersionUsed } so callers can re-encrypt rows that
 * decrypted with an old key.
 *
 * Legacy v1 / interim fallbacks exist because the live-app key rotation
 * happened before every row was migrated by rotate_wallet_seed_key.js.
 * Until every row in users.wallet_seed_key_version = 2, this fallback
 * MUST stay or those users will lose access to their seed phrases.
 */
function decryptSecretEx(encrypted, iv, tag, _keyVersion) {
  // Path 1: current v2 key
  try {
    return {
      plaintext: tryDecryptWithKey(getKeyV2(), encrypted, iv, tag),
      keyVersionUsed: 2,
    };
  } catch (errV2) {
    // Path 2: legacy v1 placeholder key (sha256 of WALLET_SEED_ENCRYPTION_KEY_V1)
    const k1 = getKeyV1();
    if (k1) {
      try {
        return {
          plaintext: tryDecryptWithKey(k1, encrypted, iv, tag),
          keyVersionUsed: 1,
        };
      } catch (_errV1) {
        // fall through to interim
      }
    }
    // Path 3: interim key (sha256 of the current hex env value)
    const kI = getKeyInterim();
    if (kI) {
      try {
        return {
          plaintext: tryDecryptWithKey(kI, encrypted, iv, tag),
          keyVersionUsed: 99,
        };
      } catch (_errI) {
        // fall through to throw
      }
    }
    throw errV2;
  }
}

/**
 * Backward-compatible wrapper that returns only the plaintext string.
 * Existing call sites in auth.js use this signature.
 */
function decryptSecret(encrypted, iv, tag, keyVersion) {
  return decryptSecretEx(encrypted, iv, tag, keyVersion).plaintext;
}


/**
 * Derives a 32-byte AES key from the user's PIN using PBKDF2.
 * Salt is deterministic: SHA-256(userId) — no extra DB column needed.
 * 100 000 iterations of HMAC-SHA256.
 */
function derivePinKey(pin, userId) {
  const salt = crypto.createHash('sha256').update(String(userId)).digest();
  return crypto.pbkdf2Sync(String(pin), salt, 100_000, 32, 'sha256');
}

/**
 * Encrypts a seed phrase with the user's PIN-derived key (AES-256-GCM).
 * The server never stores the PIN in plaintext — the key is derived at
 * call-time from the PIN that was sent over HTTPS and verified first.
 */
function encryptWithPin(plainText, pin, userId) {
  const iv = crypto.randomBytes(12);
  const key = derivePinKey(pin, userId);
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

/**
 * Decrypts a PIN-encrypted seed. Throws on wrong PIN (GCM auth tag mismatch).
 */
function decryptWithPin(encrypted, iv, tag, pin, userId) {
  const key = derivePinKey(pin, userId);
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

module.exports = {
  encryptSecret,
  decryptSecret,
  decryptSecretEx,
  encryptWithPin,
  decryptWithPin,
};
