import crypto from 'node:crypto';

export function hashPassword(password: string, salt: string): string {
  const derived = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, digest] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const candidate = hashPassword(password, salt).split('$')[2];
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(digest, 'hex'));
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('hex')}`;
}
