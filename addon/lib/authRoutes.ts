import crypto from 'crypto';
import consola from 'consola';
import redis from './redisClient';
import { getSetting } from './settingsService';
import database from './database';
import {
  attachSession,
  clearSessionCookie,
  createSession,
  destroySession,
  isSecureRequest,
  readCookie,
  setSessionCookie,
  SESSION_COOKIE,
  type Permission,
} from './authSession';
import {
  buildAuthRequest,
  exchangeCode,
  isOidcConfigured,
  readOidcConfig,
  resolvePermissions,
} from './oidc';

const logger = consola.withTag('Auth');

const FLOW_PREFIX = 'auth:flow:';
const FLOW_COOKIE = 'aiom_auth_flow';
const FLOW_TTL_SECONDS = 10 * 60;
const MAX_PROFILES = 50;
const MAX_LABEL_LENGTH = 64;

interface Flow {
  codeVerifier: string;
  nonce: string;
  next: string;
}

function resolveBaseUrl(req: any): string {
  const configured = process.env.HOST_NAME;
  if (configured) {
    return configured.startsWith('http') ? configured : `https://${configured}`;
  }
  return `${req.protocol}://${req.get('host')}`;
}

export function redirectUriFor(req: any): string {
  return `${resolveBaseUrl(req).replace(/\/+$/, '')}/api/auth/oidc/callback`;
}

/**
 * Only same-origin paths, so the provider cannot be used to bounce someone to
 * another site after a successful sign-in.
 */
function safeNext(value: unknown): string {
  const next = String(value ?? '').trim();
  if (!next.startsWith('/')) return '/configure';

  const base = 'https://aiom.invalid';
  let parsed: URL;
  try {
    parsed = new URL(next, base);
  } catch {
    return '/configure';
  }
  if (parsed.origin !== base) return '/configure';
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

function flowCookieOptions(req: any) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isSecureRequest(req),
    path: '/api/auth/oidc',
  };
}

function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Sign-in carries no configuration id to key on, so this counts per address.
 * Unlike the profile and config-load limiters it guards an unauthenticated
 * write path: every completed sign-in creates an account row.
 */
async function ssoRateLimit(req: any, res: any, next: any): Promise<void> {
  const perWindow = Math.max(1, parseInt(getSetting('OIDC_RATE_LIMIT_PER_WINDOW') || '', 10) || 20);
  const windowSeconds = Math.max(1, parseInt(getSetting('OIDC_RATE_LIMIT_WINDOW') || '', 10) || 300);

  try {
    const address = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `rate-limit:sso:${address}:${bucket}`;

    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSeconds + 10);

    if (count > perWindow) {
      logger.warn(`Rate limited sign-in attempts from ${address}`);
      return res.status(429).json({ error: 'Too many sign-in attempts. Please try again shortly.' });
    }
  } catch (error: any) {
    logger.warn(`Sign-in limiter failed, allowing request: ${error.message}`);
  }

  next();
}

export function register(addon: any, options: { rateLimit?: any } = {}): void {
  const rateLimit = options.rateLimit || ((_req: any, _res: any, next: any) => next());

  addon.use(attachSession);

  addon.get('/api/auth/status', (req: any, res: any) => {
    const config = readOidcConfig();
    res.json({
      oidcEnabled: isOidcConfigured(config),
      redirectUri: redirectUriFor(req),
      signedIn: Boolean(req.session),
    });
  });

  addon.get('/api/auth/session', (req: any, res: any) => {
    if (!req.session) return res.status(401).json({ error: 'Not signed in' });
    res.json({
      accountId: req.session.accountId,
      username: req.session.username,
      email: req.session.email,
      permissions: req.session.permissions,
    });
  });

  addon.post('/api/auth/logout', async (req: any, res: any) => {
    await destroySession(readCookie(req, SESSION_COOKIE));
    clearSessionCookie(req, res);
    res.json({ success: true });
  });

  addon.get('/api/auth/oidc/start', ssoRateLimit, async (req: any, res: any) => {
    const config = readOidcConfig();
    if (!isOidcConfigured(config)) {
      return res.status(404).json({ error: 'SSO is not configured on this instance' });
    }

    try {
      const request = await buildAuthRequest(config, redirectUriFor(req));
      const flow: Flow = {
        codeVerifier: request.codeVerifier,
        nonce: request.nonce,
        next: safeNext(req.query.next),
      };
      await redis.set(`${FLOW_PREFIX}${request.state}`, JSON.stringify(flow), 'EX', FLOW_TTL_SECONDS);
      res.cookie(FLOW_COOKIE, request.state, { ...flowCookieOptions(req), maxAge: FLOW_TTL_SECONDS * 1000 });
      res.redirect(request.url);
    } catch (error: any) {
      logger.error(`Could not start sign-in: ${error.message}`);
      res.status(502).json({ error: 'Could not reach the identity provider' });
    }
  });

  addon.get('/api/auth/oidc/callback', ssoRateLimit, async (req: any, res: any) => {
    const config = readOidcConfig();
    if (!isOidcConfigured(config)) {
      return res.status(404).json({ error: 'SSO is not configured on this instance' });
    }

    const state = trimmed(req.query.state);
    const code = trimmed(req.query.code);
    if (!state || !code) {
      return res.status(400).json({ error: 'Incomplete reply from the identity provider' });
    }

    const presented = readCookie(req, FLOW_COOKIE);
    res.clearCookie(FLOW_COOKIE, flowCookieOptions(req));
    if (!presented || !sameValue(presented, state)) {
      return res.status(400).json({ error: 'This sign-in did not start in this browser. Start again.' });
    }

    // Single use: a replayed state must not open a second session.
    const raw = await redis.get(`${FLOW_PREFIX}${state}`);
    await redis.del(`${FLOW_PREFIX}${state}`);
    if (!raw) {
      return res.status(400).json({ error: 'This sign-in is no longer valid. Start again.' });
    }

    const flow: Flow = JSON.parse(raw);

    try {
      const identity = await exchangeCode(config, code, flow.codeVerifier, flow.nonce, redirectUriFor(req));

      const permissions = resolvePermissions(identity.groups, config);
      if (permissions === null) {
        logger.warn(`Refused ${identity.subject}: nothing in the ${config.groupsClaim} claim grants access`);
        return res.status(403).send('Your account is not allowed to sign in here.');
      }

      const account = await database.upsertAccount(
        identity.issuer,
        identity.subject,
        identity.username,
        identity.email
      );

      const sessionId = await createSession({
        accountId: account.id,
        username: identity.username,
        email: identity.email,
        permissions: permissions as Permission[],
      });
      setSessionCookie(req, res, sessionId);

      logger.info(`Signed in ${identity.username} with ${permissions.length ? permissions.join(', ') : 'no'} permissions`);
      res.redirect(flow.next);
    } catch (error: any) {
      logger.error(`Sign-in failed: ${error.message}`);
      res.status(401).send('Sign-in failed. Please try again.');
    }
  });

  // --- Config profiles ---

  function requireSession(req: any, res: any, next: any) {
    if (!req.session) return res.status(401).json({ error: 'Not signed in' });
    next();
  }

  addon.get('/api/profiles', requireSession, async (req: any, res: any) => {
    try {
      const rows = await database.getAccountConfigs(req.session.accountId);
      res.json({
        profiles: rows.map((row: any) => ({
          userUUID: row.user_uuid,
          label: row.label,
          linkedAt: row.linked_at,
          lastOpenedAt: row.last_opened_at,
        })),
      });
    } catch (error: any) {
      logger.error(`Could not list profiles: ${error.message}`);
      res.status(500).json({ error: 'Could not list your configurations' });
    }
  });

  /**
   * The one place a configuration password is needed. Proving it once is what
   * links the configuration; afterwards the session stands in for it, and the
   * password is never stored.
   */
  addon.post('/api/profiles', requireSession, rateLimit, async (req: any, res: any) => {
    const userUUID = trimmed(req.body?.userUUID);
    const password = String(req.body?.password ?? '');
    const label = trimmed(req.body?.label).slice(0, MAX_LABEL_LENGTH);

    if (!userUUID || !password) {
      return res.status(400).json({ error: 'A UUID and its password are required' });
    }

    try {
      const already = await database.ownsConfig(req.session.accountId, userUUID);
      if (!already && await database.countAccountConfigs(req.session.accountId) >= MAX_PROFILES) {
        return res.status(409).json({ error: `You can save up to ${MAX_PROFILES} configurations` });
      }

      const config = await database.verifyUserAndGetConfig(userUUID, password);
      if (!config) {
        return res.status(401).json({ error: 'Invalid UUID or password' });
      }

      await database.linkAccountConfig(req.session.accountId, userUUID, label || userUUID.slice(0, 8));
      res.json({ success: true, userUUID, label: label || userUUID.slice(0, 8) });
    } catch (error: any) {
      logger.error(`Could not save profile: ${error.message}`);
      res.status(500).json({ error: 'Could not save this configuration' });
    }
  });

  addon.patch('/api/profiles/:userUUID', requireSession, async (req: any, res: any) => {
    const label = trimmed(req.body?.label).slice(0, MAX_LABEL_LENGTH);
    if (!label) return res.status(400).json({ error: 'A name is required' });

    try {
      if (!await database.ownsConfig(req.session.accountId, req.params.userUUID)) {
        return res.status(404).json({ error: 'Not one of your configurations' });
      }
      await database.linkAccountConfig(req.session.accountId, req.params.userUUID, label);
      res.json({ success: true, label });
    } catch (error: any) {
      logger.error(`Could not rename profile: ${error.message}`);
      res.status(500).json({ error: 'Could not rename this configuration' });
    }
  });

  /** Unlinks only. The configuration itself is untouched. */
  addon.delete('/api/profiles/:userUUID', requireSession, async (req: any, res: any) => {
    try {
      await database.unlinkAccountConfig(req.session.accountId, req.params.userUUID);
      res.json({ success: true });
    } catch (error: any) {
      logger.error(`Could not remove profile: ${error.message}`);
      res.status(500).json({ error: 'Could not remove this configuration' });
    }
  });
}

export { MAX_PROFILES };
