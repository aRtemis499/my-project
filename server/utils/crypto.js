const crypto = require('crypto');
const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 12; 

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


function isEncrypted(payload) {
  if (payload === null || payload === undefined) return false;
  return /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i.test(String(payload));
}

module.exports = { encrypt, decrypt, isEncrypted };