import type { NextFunction, Request, Response } from 'express';
import type { Role } from './config';
import { audit, db, getSetting, nowIso } from './db';
import { randomToken, sha256, verifyPassword } from './security';

export interface AuthUser {
  id: number;
  tenant_id: number;
  email: string;
  name: string;
  role: Role;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  kind: 'browser' | 'api';
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export const SESSION_COOKIE = 'rd_session';

export function checkCredentials(email: string, password: string): AuthUser | null {
  const row = db()
    .prepare('SELECT id, tenant_id, email, name, role, password_hash FROM users WHERE email = ? AND active = 1')
    .get(String(email ?? '').toLowerCase()) as (AuthUser & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) return null;
  const { password_hash: _omit, ...user } = row;
  return user;
}

export function issueCredential(user: AuthUser, kind: 'browser' | 'api'): { secret: string; expires_at: string; id: string } {
  const ttl = Number(getSetting(kind === 'browser' ? 'session_ttl_seconds' : 'api_token_ttl_seconds', '1800'));
  const secret = randomToken(kind === 'browser' ? 'rds' : 'rdt');
  const id = randomToken('sid').slice(0, 20);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  db()
    .prepare('INSERT INTO sessions (id, user_id, tenant_id, kind, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, user.tenant_id, kind, sha256(secret), nowIso(), expiresAt);
  audit(kind === 'browser' ? 'session.issued' : 'token.issued', user.tenant_id, user.id, { session_id: id });
  return { secret, expires_at: expiresAt, id };
}

export function revokeSession(sessionId: string): void {
  db().prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), sessionId);
}

/** Explicit revocation: ends every credential issued to the user, browser sessions and API tokens alike. */
export function revokeUserCredentials(userId: number): number {
  return db()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND kind = 'browser' AND revoked_at IS NULL")
    .run(nowIso(), userId).changes;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function resolve(req: Request): AuthContext | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const secret = bearer ? bearer[1] : readCookie(req, SESSION_COOKIE);
  if (!secret) return null;
  const kind = bearer ? 'api' : 'browser';
  const row = db()
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at, u.id, u.tenant_id, u.email, u.name, u.role, u.active
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.kind = ?`,
    )
    .get(sha256(secret), kind) as
    | { session_id: string; expires_at: string; revoked_at: string | null; id: number; tenant_id: number; email: string; name: string; role: Role; active: number }
    | undefined;
  if (!row || row.revoked_at || !row.active || row.expires_at <= nowIso()) return null;
  return {
    user: { id: row.id, tenant_id: row.tenant_id, email: row.email, name: row.name, role: row.role },
    sessionId: row.session_id,
    kind,
  };
}

export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  req.auth = resolve(req) ?? undefined;
  next();
}

export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'UNAUTHENTICATED' });
    return;
  }
  next();
}

export function requireUiAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth || req.auth.kind !== 'browser') {
    res.redirect(303, '/login');
    return;
  }
  next();
}

export function setSessionCookie(res: Response, secret: string, expiresAt: string): void {
  res.cookie(SESSION_COOKIE, secret, { httpOnly: true, sameSite: 'strict', path: '/', expires: new Date(expiresAt) });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
}
