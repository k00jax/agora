import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = process.env.DB_ENCRYPTION_KEY;
  if (!hex) throw new Error('DB_ENCRYPTION_KEY environment variable is not set');
  return Buffer.from(hex, 'hex');
}

export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv) + ':' + base64(encrypted) + ':' + base64(tag)
  return `${iv.toString('base64')}:${encrypted.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptApiKey(ciphertext: string): string {
  const key = getKey();
  const [ivB64, encryptedB64, tagB64] = ciphertext.split(':');
  if (!ivB64 || !encryptedB64 || !tagB64) throw new Error('Invalid encrypted key format');
  const iv = Buffer.from(ivB64, 'base64');
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf-8');
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}
