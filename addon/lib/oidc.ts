import crypto from 'crypto';
import consola from 'consola';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getSetting } from './settingsService';
import { ALL_PERMISSIONS, isPermission, type Permission } from './permissions';

const logger = consola.withTag('OIDC');

const DISCOVERY_PATH = '/.well-known/openid-configuration';
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export interface OidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  groupsClaim: string;
  usernameClaim: string;
  groupPermissions: Record<string, string> | null;
  defaultPermissions: string;
  allowInsecure: boolean;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

function trimmed(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * `group=perm|perm,other=perm`. JSON is accepted too, for group names that
 * contain a comma or an equals sign.
 */
let groupMapCacheRaw: string | null = null;
let groupMapCacheValue: Record<string, string> | null = null;
let groupMapCacheHit = false;

function parseGroupPermissionsUncached(raw: string): Record<string, string> | null {
  const value = trimmed(raw);
  if (!value) return {};

  const map: Record<string, string> = Object.create(null);

  if (value.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      logger.error('Group permissions is not valid JSON; refusing every sign-in until it is corrected');
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logger.error('Group permissions must be an object of group names to permissions; refusing every sign-in until it is corrected');
      return null;
    }
    for (const [group, spec] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof spec !== 'string') {
        logger.error(`Group "${group}" is not mapped to a permission string; refusing every sign-in until it is corrected`);
        return null;
      }
      map[group] = spec;
    }
    return map;
  }

  for (const pair of value.split(',')) {
    if (!pair.trim()) continue;
    const index = pair.indexOf('=');
    const group = index < 0 ? '' : pair.slice(0, index).trim();
    if (!group) {
      logger.error(`Group permissions entry "${pair.trim()}" is not "group=permission"; refusing every sign-in until it is corrected`);
      return null;
    }
    map[group] = pair.slice(index + 1).trim();
  }
  return map;
}

export function parseGroupPermissions(raw: string): Record<string, string> | null {
  if (groupMapCacheHit && groupMapCacheRaw === raw) return groupMapCacheValue;
  const parsed = parseGroupPermissionsUncached(raw);
  groupMapCacheRaw = raw;
  groupMapCacheValue = parsed;
  groupMapCacheHit = true;
  return parsed;
}

function buildOidcConfig(read: (key: string) => string): OidcConfig {
  return {
    enabled: read('OIDC_ENABLED') === 'true',
    issuer: trimmed(read('OIDC_ISSUER')).replace(/\/+$/, ''),
    clientId: trimmed(read('OIDC_CLIENT_ID')),
    clientSecret: trimmed(read('OIDC_CLIENT_SECRET')),
    groupsClaim: trimmed(read('OIDC_GROUPS_CLAIM')) || 'groups',
    usernameClaim: trimmed(read('OIDC_USERNAME_CLAIM')),
    groupPermissions: parseGroupPermissions(read('OIDC_GROUP_PERMISSIONS')),
    defaultPermissions: trimmed(read('OIDC_DEFAULT_PERMISSIONS')),
    allowInsecure: read('OIDC_ALLOW_INSECURE_ISSUER') === 'true',
  };
}

export function readOidcConfig(): OidcConfig {
  return buildOidcConfig(getSetting);
}

export type PermissionPreview =
  | { outcome: 'granted'; permissions: Permission[] }
  | { outcome: 'unconfigured' }
  | { outcome: 'malformed' }
  | { outcome: 'refused' };

/**
 * The order matches readSession, so what this predicts is what a live session
 * would actually get: an unconfigured provider ends every session regardless of
 * the mapping, while an unreadable mapping leaves existing sessions alone.
 */
export function previewPermissions(groups: string[], key: string, value: string): PermissionPreview {
  const config = buildOidcConfig((k) => (k === key ? value : getSetting(k)));
  if (!isOidcConfigured(config)) return { outcome: 'unconfigured' };
  if (config.groupPermissions === null) return { outcome: 'malformed' };
  const permissions = resolvePermissions(groups, config);
  if (permissions === null) return { outcome: 'refused' };
  return { outcome: 'granted', permissions };
}

/**
 * A plain-HTTP issuer puts the client secret and the tokens on the wire in the
 * clear, so it has to be asked for rather than fallen into.
 */
export function issuerIsAcceptable(config: OidcConfig): boolean {
  if (!config.issuer) return false;
  if (config.issuer.startsWith('https://')) return true;
  return config.allowInsecure && config.issuer.startsWith('http://');
}

export function isOidcConfigured(config: OidcConfig = readOidcConfig()): boolean {
  if (!config.enabled || !config.issuer || !config.clientId || !config.clientSecret) return false;
  if (!issuerIsAcceptable(config)) {
    logger.error(`Refusing the issuer ${config.issuer}: it is not https. Turn on the insecure issuer setting if that is deliberate.`);
    return false;
  }
  return true;
}

// ---- Permissions ----

/**
 * Null when any part is unrecognised, so a typo grants nothing rather than
 * silently granting less than intended.
 */
export function parsePermissionSpec(spec: string): Permission[] | null {
  const value = trimmed(spec);
  if (!value || value.toLowerCase() === 'none') return [];

  const granted = new Set<Permission>();
  for (const part of value.split('|')) {
    const name = part.trim();
    if (!isPermission(name)) return null;
    granted.add(name);
  }
  if (granted.has('admin')) return [...ALL_PERMISSIONS];
  return [...granted];
}

/**
 * Group names come from the provider, and `__proto__` and `constructor` are
 * legal group names that a plain lookup would answer from Object.prototype.
 */
function lookupSpec(map: Record<string, string>, group: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(map, group)) return undefined;
  const spec = map[group];
  return typeof spec === 'string' ? spec : undefined;
}

/**
 * Null refuses the login. An empty array admits with no permissions, which is
 * enough to hold a session and use profiles.
 */
export function resolvePermissions(groups: string[], config: OidcConfig): Permission[] | null {
  if (config.groupPermissions === null) {
    logger.error('Group permissions is unreadable; refusing the login');
    return null;
  }

  const granted = new Set<Permission>();
  let matched = false;

  for (const group of groups) {
    const spec = lookupSpec(config.groupPermissions, group);
    if (spec === undefined) continue;
    matched = true;
    const parsed = parsePermissionSpec(spec);
    if (parsed === null) {
      logger.error(`Group "${group}" is mapped to an unreadable permission list; refusing the login`);
      return null;
    }
    for (const permission of parsed) granted.add(permission);
  }

  if (!matched) {
    // Providers with no group claim, such as Google, rely on this instead.
    const fallback = parsePermissionSpec(config.defaultPermissions);
    if (config.defaultPermissions && fallback === null) {
      logger.error('Default permissions is unreadable; refusing the login');
      return null;
    }
    if (!config.defaultPermissions) return null;
    return fallback;
  }

  return [...granted];
}

// ---- Discovery ----

let cached: { issuer: string; at: number; document: Discovery } | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUri = '';

export async function discover(issuer: string): Promise<Discovery> {
  if (cached && cached.issuer === issuer && Date.now() - cached.at < DISCOVERY_TTL_MS) {
    return cached.document;
  }

  const response = await fetch(`${issuer}${DISCOVERY_PATH}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Provider discovery failed with ${response.status}`);
  }
  const document = await response.json() as Discovery;
  if (!document.authorization_endpoint || !document.token_endpoint || !document.jwks_uri) {
    throw new Error('Provider discovery is missing an endpoint');
  }

  cached = { issuer, at: Date.now(), document };
  return document;
}

function keySet(uri: string) {
  if (!jwks || jwksUri !== uri) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksUri = uri;
  }
  return jwks;
}

// ---- Authorization request ----

export interface AuthRequest {
  url: string;
  state: string;
  codeVerifier: string;
  nonce: string;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export async function buildAuthRequest(config: OidcConfig, redirectUri: string): Promise<AuthRequest> {
  const document = await discover(config.issuer);

  const codeVerifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = base64url(crypto.randomBytes(16));
  const nonce = base64url(crypto.randomBytes(16));

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email groups',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return { url: `${document.authorization_endpoint}?${params}`, state, codeVerifier, nonce };
}

// ---- Callback ----

export interface Identity {
  issuer: string;
  subject: string;
  username: string;
  email: string | null;
  groups: string[];
}

function readGroups(payload: JWTPayload, claim: string): string[] {
  const value = (payload as any)[claim];
  if (Array.isArray(value)) return value.map(entry => String(entry));
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
  return [];
}

export async function exchangeCode(
  config: OidcConfig,
  code: string,
  codeVerifier: string,
  nonce: string,
  redirectUri: string
): Promise<Identity> {
  const document = await discover(config.issuer);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    code_verifier: codeVerifier,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  /**
   * client_secret_basic is the default in OpenID Connect Core and what most
   * providers register a client with, so it is preferred unless the provider
   * says it only takes the secret in the body.
   */
  const supported = document.token_endpoint_auth_methods_supported;
  const usePost = Array.isArray(supported)
    && supported.includes('client_secret_post')
    && !supported.includes('client_secret_basic');

  if (usePost) {
    body.set('client_secret', config.clientSecret);
  } else {
    const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  const response = await fetch(document.token_endpoint, { method: 'POST', headers, body });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Token exchange failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const tokens = await response.json() as { id_token?: string; access_token?: string };
  if (!tokens.id_token) {
    throw new Error('Provider returned no id token');
  }

  const { payload } = await jwtVerify(tokens.id_token, keySet(document.jwks_uri), {
    issuer: document.issuer || config.issuer,
    audience: config.clientId,
  });

  if (payload.nonce !== nonce) {
    throw new Error('Reply does not match the request');
  }

  const subject = trimmed(payload.sub);
  if (!subject) {
    throw new Error('Identity has no subject');
  }

  let groups = readGroups(payload, config.groupsClaim);
  let email = trimmed((payload as any).email) || null;
  // A named claim wins, so an instance keying on email is labelled by it too.
  let name = config.usernameClaim
    ? trimmed((payload as any)[config.usernameClaim])
    : trimmed((payload as any).preferred_username) || trimmed((payload as any).name);

  /**
   * Providers differ on what they put in the id token: Authelia sends groups
   * but not the name or address, others do the reverse. Anything still missing
   * is worth one call, since falling back to the subject shows a raw id
   * wherever the account is named.
   */
  const incomplete = groups.length === 0 || !name || !email;
  if (incomplete && document.userinfo_endpoint && tokens.access_token) {
    try {
      const info = await fetch(document.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      });
      if (info.ok) {
        const claims = await info.json() as JWTPayload;
        if (groups.length === 0) groups = readGroups(claims, config.groupsClaim);
        email = email || trimmed((claims as any).email) || null;
        name = name || (config.usernameClaim
          ? trimmed((claims as any)[config.usernameClaim])
          : trimmed((claims as any).preferred_username) || trimmed((claims as any).name));
      }
    } catch (error: any) {
      logger.debug(`Could not read userinfo: ${error.message}`);
    }
  }

  return { issuer: config.issuer, subject, username: name || email || subject, email, groups };
}


