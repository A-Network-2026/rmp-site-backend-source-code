const crypto = require('crypto');
const bip39 = require('bip39');

// `ethers` is required for proper BIP-44 (m/44'/60'/0'/0/0) EVM key
// derivation used by the swap / DEX flow. Loaded lazily so a missing
// dep doesn't crash the entire auth service — non-EVM routes still work.
let _ethers = null;
function getEthers() {
  if (_ethers) return _ethers;
  try {
    _ethers = require('ethers');
  } catch (e) {
    const err = new Error(
      "EVM derivation requires the 'ethers' package. " +
      "Run: cd backend && npm install ethers@^6.13.4"
    );
    err.cause = e;
    throw err;
  }
  return _ethers;
}

function generateSeedPhrase() {
  // 128 bits entropy => 12-word BIP39 mnemonic compatible with MetaMask.
  return bip39.generateMnemonic(128);
}

function seedToPrivateKey(seed) {
  return crypto.createHash('sha256').update(String(seed || '')).digest('hex');
}

function privateToPublic(privateKey) {
  return crypto.createHash('sha256').update(String(privateKey || '')).digest('hex');
}

function publicToAddress(publicKey) {
  const hash = crypto.createHash('ripemd160').update(String(publicKey || '')).digest('hex').toUpperCase();
  return `ANET${hash.substring(0, 36)}`;
}

function generateCustomWalletAddress(passphrase) {
  const privateKey = seedToPrivateKey(passphrase);
  const publicKey = privateToPublic(privateKey);
  return publicToAddress(publicKey);
}

function createWallet() {
  const seed = generateSeedPhrase();
  const privateKey = seedToPrivateKey(seed);
  const publicKey = privateToPublic(privateKey);
  const address = publicToAddress(publicKey);

  return {
    seed,
    privateKey,
    publicKey,
    address,
  };
}

/**
 * ✅ Validate ANET wallet address format
 */
function isValidANETWallet(address) {
  if (!address || typeof address !== 'string') return false;
  // ANET prefix + 36 hex-like chars = 40 total chars
  return /^ANET[A-F0-9]{36}$/.test(String(address).toUpperCase());
}

/**
 * 🔗 EVM Wallet mapping and validation
 * Supports MetaMask and other EVM-compatible wallets
 */
function isValidEVMAddress(address) {
  if (!address || typeof address !== 'string') return false;
  // Ethereum address format: 0x + 40 hex characters
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Derive a proper EVM key from a BIP-39 mnemonic at the standard
 * Ethereum path m/44'/60'/0'/0/0. Returns { address, privateKey, publicKey }
 * that is interoperable with MetaMask, Ledger, ethers, and viem.
 *
 * NOTE: Do NOT use seedToPrivateKey() for EVM signing — that returns
 * sha256(mnemonic) which is not a valid secp256k1 scalar in general
 * and is not interoperable with any other wallet.
 */
function mnemonicToEvm(mnemonic, accountIndex = 0) {
  const m = String(mnemonic || '').trim();
  if (!bip39.validateMnemonic(m)) {
    throw new Error('Invalid BIP-39 mnemonic');
  }
  const idx = Math.max(0, Math.min(2147483647, Number(accountIndex) || 0));
  const path = `m/44'/60'/0'/0/${idx}`;
  const ethers = getEthers();
  // ethers v6: HDNodeWallet.fromPhrase(phrase, password?, path?)
  const hd = ethers.HDNodeWallet.fromPhrase(m, '', path);
  return {
    address: hd.address,
    privateKey: hd.privateKey, // 0x-prefixed 32-byte hex
    publicKey: hd.publicKey,   // 0x-prefixed compressed/uncompressed depending on version
    path,
  };
}

function mnemonicToEvmAddress(mnemonic, accountIndex = 0) {
  return mnemonicToEvm(mnemonic, accountIndex).address;
}

/**
 * ──────────────────────────────────────────────────────────────────────
 * ANET L1 wallet address derivations from a secp256k1 EVM private key.
 *
 * Two schemes live on the chain today:
 *
 *   secp_addr   = "ANET" + RIPEMD160(compressed_secp_pubkey)[..36] (UPPER)
 *   legacy_addr = "ANET" + RIPEMD160(SHA256(hex_lower(privkey)).bytes())[..36]
 *
 * Legacy wallets cannot produce valid secp signatures, so they can't
 * call signed-action endpoints (dex_swap, bridge_burn, …). The chain
 * exposes a /wallet/migrate-legacy commit-reveal flow to move balances
 * onto the secp address. These helpers mirror
 * `bsc-relayer/scripts/migrate-legacy-wallet.js` so the rmp-site
 * backend can run the migration server-side using the user's
 * PIN-decrypted seed.
 * ──────────────────────────────────────────────────────────────────────
 */

function _hexLower(buf) {
  return Buffer.from(buf).toString('hex');
}

function _compressPubKey(uncompressed65) {
  if (uncompressed65.length !== 65 || uncompressed65[0] !== 0x04) {
    throw new Error('compressPubKey: expected 65-byte 0x04-prefixed key');
  }
  const x = uncompressed65.subarray(1, 33);
  const y = uncompressed65.subarray(33, 65);
  const prefix = (y[31] & 1) === 0 ? 0x02 : 0x03;
  return Buffer.concat([Buffer.from([prefix]), x]);
}

function _privKeyBufFromHex(hex) {
  const clean = String(hex || '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('private key must be 32-byte hex (64 chars, optional 0x prefix)');
  }
  return Buffer.from(clean, 'hex');
}

function evmPrivKeyToSecpAnetAddress(privKeyHex) {
  const privBuf = _privKeyBufFromHex(privKeyHex);
  const ethers = getEthers();
  // ethers v6: SigningKey.computePublicKey(privkey, compressed?)
  const uncompressedHex = ethers.SigningKey.computePublicKey('0x' + privBuf.toString('hex'), false);
  const uncompressed = Buffer.from(uncompressedHex.slice(2), 'hex');
  const compressed = _compressPubKey(uncompressed);
  const ripe = crypto.createHash('ripemd160').update(compressed).digest();
  return 'ANET' + ripe.toString('hex').toUpperCase().slice(0, 36);
}

function evmPrivKeyToLegacyAnetAddress(privKeyHex) {
  // Mirrors transaction.rs::derive_legacy_address_from_privkey_bytes:
  //   priv_str = hex_lower(privkey_bytes)
  //   pub_str  = hex_lower(SHA256(priv_str.bytes()))
  //   addr     = "ANET" + hex_upper(RIPEMD160(pub_str.bytes()))[..36]
  const privBuf = _privKeyBufFromHex(privKeyHex);
  const privStr = _hexLower(privBuf);
  const pubStr = crypto.createHash('sha256').update(Buffer.from(privStr, 'utf8')).digest('hex');
  const ripe = crypto.createHash('ripemd160').update(Buffer.from(pubStr, 'utf8')).digest();
  return 'ANET' + ripe.toString('hex').toUpperCase().slice(0, 36);
}

/**
 * Sort object keys and emit `{"k1":v1,"k2":v2}` so the canonical preimage
 * matches what the chain reconstructs (and what the Flutter wallet and
 * relayer scripts produce).
 */
function _canonicalPayload(payload) {
  const obj = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const keys = Object.keys(obj).sort();
  const inner = keys.map((k) => `"${k}":${JSON.stringify(obj[k])}`).join(',');
  return `{${inner}}`;
}

function _bigIntTo32(buf) {
  if (buf.length === 32) return buf;
  if (buf.length > 32) return buf.subarray(buf.length - 32);
  const out = Buffer.alloc(32);
  buf.copy(out, 32 - buf.length);
  return out;
}

/**
 * Build an ActionAuth payload signed by `privKeyHex` for the chain's
 * `verify_signed_action_authorization`. `wallet` is the on-chain wallet
 * the signature must recover to (the secp address).
 */
function signAnetActionAuth({ privKeyHex, wallet, actionType, chainId, payload }) {
  const ethers = getEthers();
  const ts = new Date();
  const nonce = ts.getTime();
  const safePayload = payload && typeof payload === 'object' ? payload : { route: actionType };
  const payloadCanon = _canonicalPayload(safePayload);
  const preimage =
    `action-v1|${actionType}|${String(wallet).toUpperCase()}|${nonce}|${ts.getTime()}|${chainId}|${payloadCanon}`;
  const hash = crypto.createHash('sha256').update(Buffer.from(preimage, 'utf8')).digest();
  const actionHash = hash.toString('hex').toLowerCase();
  const signingKey = new ethers.SigningKey('0x' + _privKeyBufFromHex(privKeyHex).toString('hex'));
  const sig = signingKey.sign('0x' + hash.toString('hex'));
  let v = sig.yParity;
  if (v === undefined || v === null) v = sig.v === 27 ? 0 : sig.v === 28 ? 1 : sig.v;
  if (v === 27) v = 0;
  if (v === 28) v = 1;
  const r = _bigIntTo32(Buffer.from(sig.r.slice(2), 'hex'));
  const s = _bigIntTo32(Buffer.from(sig.s.slice(2), 'hex'));
  const sigBytes = Buffer.concat([r, s, Buffer.from([v])]);
  return {
    wallet: String(wallet).toUpperCase(),
    nonce,
    timestamp: ts.toISOString(),
    chain_id: chainId,
    payload: safePayload,
    signature: sigBytes.toString('hex').toLowerCase(),
    action_hash: actionHash,
  };
}

module.exports = {
  generateSeedPhrase,
  seedToPrivateKey,
  privateToPublic,
  publicToAddress,
  generateCustomWalletAddress,
  createWallet,
  isValidANETWallet,
  isValidEVMAddress,
  mnemonicToEvm,
  mnemonicToEvmAddress,
  evmPrivKeyToSecpAnetAddress,
  evmPrivKeyToLegacyAnetAddress,
  signAnetActionAuth,
};
