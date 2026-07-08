// Encrypt/decrypt secrets at rest. Uses bcrypt for one-way hashing (passwords
// aren't retrieved, just compared), but for settings that must be decrypted
// (SYSPRO password, SMTP password), use a simple XOR-style approach with a
// salt derived from a server-local key. Not as strong as AES, but good enough
// for a single-server on a private LAN where the alternative is plaintext.
//
// If you deploy to an untrusted environment later (cloud shared host), upgrade
// to proper AES-256 encryption with a .env key.
import bcryptjs from 'bcryptjs';
import crypto from 'crypto';

const SALT_ROUNDS = 10;
const ENCRYPTION_KEY = process.env.SECRET_KEY || 'routeone-local-encryption-key-change-in-production';

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
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plain, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  // Prepend IV so decrypt knows how to reverse it
  return `aes:${iv.toString('hex')}:${encrypted}`;
}

// Decrypt a secret (returns the plaintext for use in connections).
export function decryptSecret(ciphertext) {
  if (!ciphertext || !ciphertext.startsWith('aes:')) return '';
  try {
    const [, ivHex, encrypted] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
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
  return typeof value === 'string' && value.startsWith('aes:');
}
