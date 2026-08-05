import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';

const logger = consola.withTag('AuthSession');

export const SESSION_COOKIE = 'aiom_session';
const SESSION_PREFIX = 'auth:session:';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** What an identity is allowed to do. Deny by default: an empty list is valid. */
export type Permission = 'admin' | 'createConfig';

export const ALL_PERMISSIONS: Permission[] = ['admin', 'createConfig'];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

export interface SessionData {
  accountId: string;
  username: string;
  email: string | null;
  permissions: Permission[];
  createdAt: number;
}

export function sessionTtlSeconds(): number {
  const parsed = parseInt(getSetting('SESSION_TTL_SECONDS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

export async function createSession(data: Omit<SessionData, 'createdAt'>): Promise<string> {
  const id = crypto.randomBytes(32).toString('base64url');
  const payload: SessionData = { ...data, createdAt: Date.now() };
  await redis.set(`${SESSION_PREFIX}${id}`, JSON.stringify(payload), 'EX', sessionTtlSeconds());
  return id;
}

export async function readSession(id: string | undefined): Promise<SessionData | null> {
  if (!id) return null;
  try {
    const raw = await redis.get(`${SESSION_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      permissions: Array.isArray(parsed.permissions) ? parsed.permissions.filter(isPermission) : [],
    };
  } catch (error: any) {
    logger.warn(`Could not read session: ${error.message}`);
    return null;
  }
}

export async function destroySession(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await redis.del(`${SESSION_PREFIX}${id}`);
  } catch (error: any) {
    logger.warn(`Could not destroy session: ${error.message}`);
  }
}

/** Every session for one account, used when its access is revoked. */
export async function destroyAccountSessions(accountId: string): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${SESSION_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        if (JSON.parse(raw).accountId === accountId) {
          await redis.del(key);
          removed += 1;
        }
      } catch {
        // Unreadable value, leave it to expire on its own.
      }
    }
  } while (cursor !== '0');
  return removed;
}

/** Express has res.cookie but no reader, and one header parse beats a dependency. */
export function readCookie(req: any, name: string): string | undefined {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export function isSecureRequest(req: any): boolean {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

export function setSessionCookie(req: any, res: any, id: string): void {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: sessionTtlSeconds() * 1000,
    path: '/',
  });
}

export function clearSessionCookie(req: any, res: any): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  });
}

/**
 * Attaches the session to the request without gating anything, so routes that
 * are open to everyone can still tell who is signed in.
 */
export async function attachSession(req: any, _res: any, next: any): Promise<void> {
  try {
    req.session = await readSession(readCookie(req, SESSION_COOKIE));
  } catch {
    req.session = null;
  }
  next();
}

/** `admin` is a superset, so mapping a group to it alone grants everything. */
export function hasPermission(req: any, permission: Permission): boolean {
  const permissions: Permission[] | undefined = req?.session?.permissions;
  if (!Array.isArray(permissions)) return false;
  return permissions.includes(permission) || permissions.includes('admin');
}
