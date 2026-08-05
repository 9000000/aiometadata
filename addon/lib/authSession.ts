import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';
import { isPermission, type Permission } from './permissions';
import { isOidcConfigured, readOidcConfig, resolvePermissions } from './oidc';

const logger = consola.withTag('AuthSession');

export const SESSION_COOKIE = 'aiom_session';
const SESSION_PREFIX = 'auth:session:';
const ACCOUNT_SESSIONS_PREFIX = 'auth:account-sessions:';

function accountSessionsKey(accountId: string): string {
  return `${ACCOUNT_SESSIONS_PREFIX}${accountId}`;
}
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export { ALL_PERMISSIONS, isPermission, type Permission } from './permissions';

export interface SessionData {
  accountId: string;
  username: string;
  email: string | null;
  permissions: Permission[];
  groups: string[];
  createdAt: number;
}

export function sessionTtlSeconds(): number {
  const parsed = parseInt(getSetting('SESSION_TTL_SECONDS') || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

export async function createSession(data: Omit<SessionData, 'createdAt'>): Promise<string> {
  const id = crypto.randomBytes(32).toString('base64url');
  const payload: SessionData = { ...data, createdAt: Date.now() };
  const ttl = sessionTtlSeconds();
  await redis.set(`${SESSION_PREFIX}${id}`, JSON.stringify(payload), 'EX', ttl);
  try {
    const key = accountSessionsKey(data.accountId);
    await redis.zadd(key, Date.now() + ttl * 1000, id);
    await redis.expire(key, ttl + 60);
  } catch (error: any) {
    logger.warn(`Could not index session for ${data.accountId}: ${error.message}`);
  }
  return id;
}

export async function readSession(id: string | undefined): Promise<SessionData | null> {
  if (!id) return null;
  try {
    const raw = await redis.get(`${SESSION_PREFIX}${id}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const stored: Permission[] = Array.isArray(parsed.permissions)
      ? parsed.permissions.filter(isPermission)
      : [];

    if (!Array.isArray(parsed.groups)) {
      return { ...parsed, groups: [], permissions: stored };
    }

    const config = readOidcConfig();
    if (!isOidcConfigured(config)) return null;

    const resolved = resolvePermissions(parsed.groups, config);
    if (resolved !== null) return { ...parsed, permissions: resolved };

    if (config.groupPermissions === null) {
      logger.error(`Group mapping is unreadable; keeping last known permissions for ${parsed.username}`);
      return { ...parsed, permissions: stored };
    }

    logger.info(`Signing out ${parsed.username}: the group mapping no longer grants access`);
    await destroySession(id);
    return null;
  } catch (error: any) {
    logger.warn(`Could not read session: ${error.message}`);
    return null;
  }
}

export async function destroySession(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    const raw = await redis.get(`${SESSION_PREFIX}${id}`);
    await redis.del(`${SESSION_PREFIX}${id}`);
    if (raw) {
      const accountId = JSON.parse(raw)?.accountId;
      if (accountId) await redis.zrem(accountSessionsKey(accountId), id);
    }
  } catch (error: any) {
    logger.warn(`Could not destroy session: ${error.message}`);
  }
}

export async function countAccountSessions(accountId: string): Promise<number> {
  try {
    const key = accountSessionsKey(accountId);
    await redis.zremrangebyscore(key, 0, Date.now());
    return await redis.zcard(key);
  } catch (error: any) {
    logger.warn(`Could not count sessions for ${accountId}: ${error.message}`);
    return 0;
  }
}

/** Every session for one account, used when its access is revoked. */
export async function destroyAccountSessions(accountId: string): Promise<number> {
  try {
    const key = accountSessionsKey(accountId);
    const ids: string[] = await redis.zrange(key, 0, -1);
    for (const id of ids) {
      await redis.del(`${SESSION_PREFIX}${id}`);
    }
    await redis.del(key);
    return ids.length;
  } catch (error: any) {
    logger.warn(`Could not revoke sessions for ${accountId}: ${error.message}`);
    return 0;
  }
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
