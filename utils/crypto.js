const crypto = require('crypto');

// AES-256-GCM: authenticated encryption — tampering with the stored value
// is detectable, not just reversible-if-you-have-the-key.
//
// Key comes from Render env, NOT from Supabase — keeping it out of the
// database entirely means a leaked/dumped DB alone is not enough to
// recover trading passwords.
//
// Generate a key once with:  openssl rand -hex 32
// Then set it in Render:     TRADING_PASSWORD_ENCRYPTION_KEY=<that value>
//
// Rotating this key requires re-encrypting every stored value (decrypt
// with old key, encrypt with new key) — there's no way around that with
// symmetric encryption, so treat it as a long-lived secret, not something
// to rotate casually.

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 12; // 96-bit IV, recommended size for GCM

function getKey() {
  const keyHex = process.env.TRADING_PASSWORD_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('TRADING_PASSWORD_ENCRYPTION_KEY is not set.');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('TRADING_PASSWORD_ENCRYPTION_KEY must be a 32-byte key, 64 hex characters (generate with: openssl rand -hex 32).');
  }
  return key;
}

// Returns "iv:authTag:ciphertext" — all hex, colon-separated, stored as a
// single string in the existing trading_password text column. No schema
// change needed.
function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return plainText;

  const key    = getKey();
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload) {
  if (payload === null || payload === undefined || payload === '') return payload;

  const parts = String(payload).split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Value is not in the expected encrypted format (iv:authTag:ciphertext). ' +
      'This usually means it is legacy plaintext that has not been through the backfill script yet.'
    );
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const key       = getKey();
  const iv        = Buffer.from(ivHex, 'hex');
  const authTag   = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// Lets callers (like the backfill script) check whether a value is already
// in encrypted form without needing the key or risking a throw.
function isEncrypted(payload) {
  if (payload === null || payload === undefined) return false;
  return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i.test(String(payload));
}

module.exports = { encrypt, decrypt, isEncrypted };