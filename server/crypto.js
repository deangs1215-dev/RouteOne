// Encrypt/decrypt secrets at rest. Uses bcrypt for one-way hashing (passwords
// aren't retrieved, just compared). For settings that must be decrypted again
// for use (SYSPRO password, SMTP password), uses authenticated AES-256-GCM with
// a random IV per value, keyed from SECRET_KEY (see .env.example).
import bcryptjs from 'bcryptjs';
import crypto from 'crypto';

const SALT_ROUNDS = 10;
const FALLBACK_KEY = 'routeone-local-encryption-key-change-in-production';
if (!process.env.SECRET_KEY) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SECRET_KEY is required in production');
  }
  console.warn('! SECRET_KEY is not set - falling back to an insecure hardcoded key. ' +
    'Set SECRET_KEY in .env before storing any real secrets (see .env.example).');
}
const ENCRYPTION_KEY = process.env.SECRET_KEY || FALLBACK_KEY;

// Hash a password (one-way, for user auth). Always use this, never raw plaintext.
export async function hashPassword(plain) {
  return bcryptjs.hash(plain, SALT_ROUNDS);
}

// Compare a plaintext password against a bcrypt hash (user auth).
export async function comparePassword(plain, hash) {
  return bcryptjs.compare(plain, hash);
}

// Encrypt a secret (syspro_password, smtp_password) so it's not plaintext at rest.
// Returns a cipher string that can be stored in the database.
export function encryptSecret(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plain, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `gcm:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

// Decrypt a secret (returns the plaintext for use in connections).
export function decryptSecret(ciphertext) {
  if (!ciphertext || (!ciphertext.startsWith('gcm:') && !ciphertext.startsWith('aes:'))) return '';
  try {
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const parts = ciphertext.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const encrypted = parts[parts.length - 1];
    const decipher = crypto.createDecipheriv(
      parts[0] === 'gcm' ? 'aes-256-gcm' : 'aes-256-cbc',
      key,
      iv
    );
    if (parts[0] === 'gcm') decipher.setAuthTag(Buffer.from(parts[2], 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Failed to decrypt secret:', e.message);
    return '';
  }
}

// Check if a setting value looks encrypted (vs plaintext). Used to auto-migrate
// old plaintext passwords on first read.
export function isEncrypted(value) {
  return typeof value === 'string' && (value.startsWith('gcm:') || value.startsWith('aes:'));
}
