import * as path from 'node:path';
import consola from 'consola';
import { parseDurationMs } from './duration';

const logger = consola.withTag('PosterCache');


export type ImageClass = 'poster' | 'background' | 'landscape' | 'logo' | 'thumbnail' | 'processed';

/** Every class the store can hold — used for stats, purging and eviction. */
export const IMAGE_CLASSES: ImageClass[] = [
  'poster',
  'background',
  'landscape',
  'logo',
  'thumbnail',
  'processed',
];

export const URL_ADDRESSABLE_CLASSES: ImageClass[] = IMAGE_CLASSES.filter(
  (imageClass) => imageClass !== 'processed'
);

/** Meta field name -> cache class. `poster` is always on; the rest are opt-in. */
export const META_FIELD_CLASSES: Record<string, ImageClass> = {
  poster: 'poster',
  background: 'background',
  landscapePoster: 'landscape',
  logo: 'logo',
};

/** Env var gating each class. `poster` has no toggle — it is the default. */
const CLASS_ENV: Record<Exclude<ImageClass, 'poster'>, string> = {
  background: 'POSTER_CACHE_BACKGROUNDS',
  landscape: 'POSTER_CACHE_LANDSCAPE_POSTERS',
  logo: 'POSTER_CACHE_LOGOS',
  thumbnail: 'POSTER_CACHE_THUMBNAILS',
  processed: 'POSTER_CACHE_PROCESSED_IMAGES',
};

export function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value || '');
}

export function isExplicitlyDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value || '').trim());
}

export function isBuiltinPosterCacheEnabled(): boolean {
  return isTruthy(process.env.ENABLE_BUILTIN_POSTER_CACHE);
}

export function isClassEnabled(imageClass: ImageClass): boolean {
  if (!isBuiltinPosterCacheEnabled()) return false;
  if (imageClass === 'poster') return true;
  if (imageClass === 'processed') return !isExplicitlyDisabled(process.env.POSTER_CACHE_PROCESSED_IMAGES);
  return isTruthy(process.env[CLASS_ENV[imageClass]]);
}

export function getEnabledClasses(): ImageClass[] {
  return IMAGE_CLASSES.filter(isClassEnabled);
}

export function isFieldCacheable(field: string): boolean {
  const imageClass = META_FIELD_CLASSES[field];
  if (!imageClass) return false;
  if (!isBuiltinPosterCacheEnabled()) {
    return imageClass === 'poster' && !!getPosterProxyPrefix();
  }
  return isClassEnabled(imageClass);
}

export function getCacheableFields(): string[] {
  return Object.keys(META_FIELD_CLASSES).filter(isFieldCacheable);
}

export function buildCachedUrl(base: string, imageClass: ImageClass, url: string): string {
  if (!isBuiltinPosterCacheEnabled()) return `${base}/${url}`;
  return `${base}/${imageClass}/${url}`;
}

export function isValidImageClass(value: unknown): value is ImageClass {
  return typeof value === 'string' && (IMAGE_CLASSES as string[]).includes(value);
}

function normalizeBase(value: string | undefined): string {
  const trimmed = (value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export const POSTER_CACHE_ROUTE = '/poster-cache';

export function getPosterProxyPrefix(): string {
  const explicit = (process.env.POSTER_PROXY_PREFIX_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (!isBuiltinPosterCacheEnabled()) return '';
  const host = normalizeBase(process.env.HOST_NAME);
  return host ? `${host}${POSTER_CACHE_ROUTE}` : '';
}

export function getPosterWarmupBase(): string {
  const explicit = (process.env.POSTER_WARMUP_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (isBuiltinPosterCacheEnabled()) {
    const port = parseInt(process.env.PORT || '3232', 10);
    return `http://127.0.0.1:${port}${POSTER_CACHE_ROUTE}`;
  }
  return getPosterProxyPrefix();
}

export function getSelfOrigin(): string {
  const host = normalizeBase(process.env.HOST_NAME);
  if (!host) return '';
  try {
    return new URL(host).origin;
  } catch {
    return '';
  }
}

export function getCacheDir(): string {
  const configured = (process.env.POSTER_CACHE_DIR || '').trim();
  if (configured) return configured;
  return path.join(process.cwd(), 'addon', 'data', 'poster-cache');
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
};

export function parseSize(value: string | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value || '');
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit ? SIZE_UNITS[unit] : 1;
  if (!multiplier || !Number.isFinite(amount)) return null;
  return Math.floor(amount * multiplier);
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

/** Disk budget for stored images. */
export const DEFAULT_MAX_SIZE = '10g';

export function getMaxSizeRaw(): string {
  return (process.env.POSTER_CACHE_MAX_SIZE || '').trim() || DEFAULT_MAX_SIZE;
}

export function getMaxBytes(): number {
  return parseSize(getMaxSizeRaw()) ?? parseSize(DEFAULT_MAX_SIZE)!;
}

export const DEFAULT_MEMORY_SIZE = '128m';

export function getMemorySizeRaw(): string {
  const raw = (process.env.POSTER_CACHE_MEMORY_SIZE ?? '').trim();
  return raw !== '' ? raw : DEFAULT_MEMORY_SIZE;
}

export function getMemoryBudget(): number {
  const parsed = parseSize(getMemorySizeRaw());
  return parsed === null ? parseSize(DEFAULT_MEMORY_SIZE)! : parsed;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UpstreamCacheMeta {
  maxAge?: number;
  sMaxAge?: number;
  age?: number;
  date?: number;
  expires?: number;
  etag?: string;
  lastModified?: string;
  lastModifiedAt?: number;
  immutable?: boolean;
  noStore?: boolean;
  noCache?: boolean;
  mustRevalidate?: boolean;
}

const MAX_AGE_RE = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?/;
const SHARED_MAX_AGE_RE = /(?:^|,)\s*s-maxage\s*=\s*"?(\d+)"?/;
const NO_STORE_RE = /(?:^|,)\s*no-store\s*(?:,|$)/;
const NO_CACHE_RE = /(?:^|,)\s*no-cache\s*(?:,|$)/;
const IMMUTABLE_RE = /(?:^|,)\s*immutable\s*(?:,|$)/;
const MUST_REVALIDATE_RE = /(?:^|,)\s*must-revalidate\s*(?:,|$)/;

/** An HTTP date we cannot read is no date at all — never a NaN handed to the policy. */
function parseHttpDate(value: unknown): number | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Reads the freshness promise and validators off a response. Absent fields stay absent. */
export function parseUpstreamCacheMeta(headers: Record<string, any> = {}): UpstreamCacheMeta {
  const meta: UpstreamCacheMeta = {};

  const cacheControl = String(headers['cache-control'] || '').toLowerCase();
  if (cacheControl) {
    // Three different answers: `no-store` refuses storage, `no-cache` refuses reuse
    // without revalidating first, `must-revalidate` refuses reuse once stale.
    if (NO_STORE_RE.test(cacheControl)) meta.noStore = true;
    if (NO_CACHE_RE.test(cacheControl)) meta.noCache = true;
    if (MUST_REVALIDATE_RE.test(cacheControl)) meta.mustRevalidate = true;
    if (IMMUTABLE_RE.test(cacheControl)) meta.immutable = true;
    const shared = SHARED_MAX_AGE_RE.exec(cacheControl)?.[1];
    if (shared !== undefined) meta.sMaxAge = Number(shared);
    const seconds = MAX_AGE_RE.exec(cacheControl)?.[1];
    if (seconds !== undefined) meta.maxAge = Number(seconds);
  }

  const age = Number.parseInt(String(headers['age'] ?? ''), 10);
  if (Number.isFinite(age) && age >= 0) meta.age = age;

  const date = parseHttpDate(headers['date']);
  if (date !== undefined) meta.date = date;

  const expires = parseHttpDate(headers['expires']);
  if (expires !== undefined) meta.expires = expires;

  const etag = String(headers['etag'] || '').trim();
  if (etag) meta.etag = etag;

  const lastModified = String(headers['last-modified'] || '').trim();
  if (lastModified) {
    meta.lastModified = lastModified;
    const lastModifiedAt = parseHttpDate(lastModified);
    if (lastModifiedAt !== undefined) meta.lastModifiedAt = lastModifiedAt;
  }

  return meta;
}

export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 365;

function ttlDaysFrom(raw: string | undefined, fallback: number): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  // Junk is not a configuration, so the shipped default stands.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The flat default, in days. `0` means never expire. */
export function getEntryTtlDays(): number {
  return ttlDaysFrom(process.env.POSTER_CACHE_TTL_DAYS, DEFAULT_TTL_DAYS);
}

/** The one flat validity. `0` means never expire. */
export function getEntryTtlMs(): number {
  const days = getEntryTtlDays();
  return days > 0 ? days * DAY_MS : Infinity;
}

export function isInferTtlEnabled(): boolean {
  return isTruthy(process.env.POSTER_CACHE_INFER_TTL);
}

export const DO_NOT_STORE = Symbol('do-not-store');

export type InferredFreshness = number | null | typeof DO_NOT_STORE;

const ONE_YEAR_MS = MAX_TTL_DAYS * DAY_MS;

const HEURISTIC_MIN_ELAPSED_SECONDS = 10 * 24 * 60 * 60;

function zero(upstream: UpstreamCacheMeta): number | null {
  return (upstream.etag || upstream.lastModified) ? 0 : null;
}

// RFC 9111
function heuristicSeconds(upstream: UpstreamCacheMeta): number | null {
  if (upstream.lastModifiedAt === undefined || upstream.date === undefined) return null;
  const elapsed = (upstream.date - upstream.lastModifiedAt) / 1000;
  if (elapsed < HEURISTIC_MIN_ELAPSED_SECONDS) return null;
  return elapsed * 0.10;
}

export function inferFreshnessMs(upstream?: UpstreamCacheMeta): InferredFreshness {
  if (!upstream) return null;
  if (upstream.noStore) return DO_NOT_STORE;
  if (upstream.noCache) return zero(upstream);
  if (upstream.immutable) return ONE_YEAR_MS;

  const lifetimeSeconds =
    // We are a shared cache, so `s-maxage` outranks `max-age`.
    upstream.sMaxAge
    ?? upstream.maxAge
    ?? (upstream.expires !== undefined && upstream.date !== undefined
      ? (upstream.expires - upstream.date) / 1000
      : null)
    ?? heuristicSeconds(upstream);

  if (lifetimeSeconds === null) return null; // Nothing was promised at all.

  const remaining = lifetimeSeconds - (upstream.age ?? 0); // The promise was already running.
  if (remaining <= 0) return zero(upstream);
  return Math.min(ONE_YEAR_MS, remaining * 1000);
}

// --- per-provider policy --------------------------------------------------

export { parseDurationMs };

export type TtlPolicy = 'default' | 'infer' | 'custom' | 'bypass';

export interface ProviderPolicy {
  domain: string;
  policy: TtlPolicy;
  ttl?: string;
}

export interface ResolvedPolicy {
  policy: TtlPolicy;
  /** Set only for `custom`. */
  ttlMs?: number;
}

export const KNOWN_ART_PROVIDERS: ReadonlyArray<{ domain: string; group: 'source' | 'rating' }> = [
  { domain: 'image.tmdb.org', group: 'source' },
  { domain: 'artworks.thetvdb.com', group: 'source' },
  { domain: 'cdn.myanimelist.net', group: 'source' },
  { domain: 'media.kitsu.app', group: 'source' },
  { domain: 'assets.fanart.tv', group: 'source' },
  { domain: 'images.metahub.space', group: 'source' },
  { domain: 'api.ratingposterdb.com', group: 'rating' },
  { domain: 'api.top-posters.com', group: 'rating' },
  { domain: 'btttr.cc', group: 'rating' },
  { domain: 'extendedratings.com', group: 'rating' },
  { domain: 'postersplus.elfhosted.com', group: 'rating' },
];

const TTL_POLICIES: TtlPolicy[] = ['default', 'infer', 'custom', 'bypass'];

export function parseProviderPolicies(raw: unknown): ProviderPolicy[] | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const rules: ProviderPolicy[] = [];
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const { domain, policy, ttl } = candidate as Record<string, unknown>;
    if (typeof domain !== 'string' || domain.trim() === '') return null;
    if (typeof policy !== 'string' || !TTL_POLICIES.includes(policy as TtlPolicy)) return null;
    if (policy === 'custom' && parseDurationMs(ttl) === null) return null;
    rules.push({
      domain: domain.trim().toLowerCase().replace(/^\.+/, ''),
      policy: policy as TtlPolicy,
      ttl: typeof ttl === 'string' ? ttl : undefined,
    });
  }
  return rules;
}

// Memoised per value: this is read on every cache read, and the parse is not.
let policyRaw: string | null = null;
let policyRules: ProviderPolicy[] = [];

function activeRules(): ProviderPolicy[] {
  const raw = process.env.POSTER_CACHE_PROVIDER_POLICIES ?? '';
  if (raw === policyRaw) return policyRules;

  policyRaw = raw;
  const parsed = parseProviderPolicies(raw);
  if (parsed === null) {
    logger.warn(
      'POSTER_CACHE_PROVIDER_POLICIES is not valid — ignoring it, so every provider falls back to its bucket default'
    );
    policyRules = [];
  } else {
    policyRules = parsed;
  }
  return policyRules;
}

export const KEY_PREFIXES: readonly string[] = ['rating-poster:', 'blur:', 'b2b:'];

export function hostFromKey(key: string): string | null {
  let candidate = key;
  for (const prefix of KEY_PREFIXES) {
    if (candidate.startsWith(prefix)) {
      candidate = candidate.slice(prefix.length);
      break;
    }
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Exact host or dot-suffix, so `elfhosted.com` covers `postersplus.elfhosted.com`. */
function ruleFor(host: string, rules: ProviderPolicy[]): ProviderPolicy | null {
  let best: ProviderPolicy | null = null;
  for (const rule of rules) {
    if (host !== rule.domain && !host.endsWith(`.${rule.domain}`)) continue;
    // Most specific wins, so the answer does not depend on how the list is ordered.
    if (!best || rule.domain.length > best.domain.length) best = rule;
  }
  return best;
}

/** Most specific first: an operator's domain rule, then the global toggle, then the bucket. */
export function resolvePolicyFor(key: string): ResolvedPolicy {
  const rules = activeRules();
  if (rules.length > 0) {
    const host = hostFromKey(key);
    const rule = host ? ruleFor(host, rules) : null;
    if (rule) {
      return rule.policy === 'custom'
        ? { policy: 'custom', ttlMs: parseDurationMs(rule.ttl)! }
        : { policy: rule.policy };
    }
  }
  return { policy: isInferTtlEnabled() ? 'infer' : 'default' };
}

export function isBypassed(key: string): boolean {
  if (!isBuiltinPosterCacheEnabled()) return false;
  return resolvePolicyFor(key).policy === 'bypass';
}

export function resolveEntryTtlMs(key: string, upstream?: UpstreamCacheMeta): number {
  const flatMs = getEntryTtlMs();
  const { policy, ttlMs } = resolvePolicyFor(key);

  if (policy === 'custom') return ttlMs!;
  if (policy !== 'infer') return flatMs;

  const inferred = inferFreshnessMs(upstream);
  if (inferred === DO_NOT_STORE) return 0;
  return inferred === null ? flatMs : inferred;
}

export function inferredTtlMsFor(upstream?: UpstreamCacheMeta): number | null {
  const inferred = inferFreshnessMs(upstream);
  return inferred === DO_NOT_STORE ? 0 : inferred;
}

export function resolveEntryTtlMsFrom(key: string, inferredMs: number | null): number {
  const flatMs = getEntryTtlMs();
  const { policy, ttlMs } = resolvePolicyFor(key);

  if (policy === 'custom') return ttlMs!;
  if (policy !== 'infer') return flatMs;
  return inferredMs === null ? flatMs : inferredMs;
}

export function isNotStorable(key: string, upstream?: UpstreamCacheMeta): boolean {
  return resolvePolicyFor(key).policy === 'infer' && inferFreshnessMs(upstream) === DO_NOT_STORE;
}

export function getEntryExpiry(key: string, storedAt: number, upstream?: UpstreamCacheMeta): number {
  const ttl = resolveEntryTtlMs(key, upstream);
  return Number.isFinite(ttl) ? storedAt + ttl : Infinity;
}

/** `getEntryExpiry` from a kept inference. See `resolveEntryTtlMsFrom`. */
export function getEntryExpiryFrom(key: string, storedAt: number, inferredMs: number | null): number {
  const ttl = resolveEntryTtlMsFrom(key, inferredMs);
  return Number.isFinite(ttl) ? storedAt + ttl : Infinity;
}

const MAX_BROWSER_MAX_AGE = 365 * 24 * 60 * 60;

/** Client validity when no entry is in hand — passthrough and bypass responses. */
export function getBrowserMaxAgeSeconds(): number {
  const ttl = getEntryTtlMs();
  if (!Number.isFinite(ttl)) return MAX_BROWSER_MAX_AGE;
  return Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(ttl / 1000)));
}

/**
 * A client is never told less than a minute — a whole catalogue revalidating on
 * every single request is its own failure mode — nor more than a year.
 */
export function clampBrowserMaxAge(seconds: number): number {
  if (!Number.isFinite(seconds)) return MAX_BROWSER_MAX_AGE;
  return Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(seconds)));
}

/** Clients are told what is left of this entry's validity, so they revalidate when we do. */
export function browserMaxAgeFor(expiresAt: number): number {
  if (!Number.isFinite(expiresAt)) return MAX_BROWSER_MAX_AGE;
  return clampBrowserMaxAge((expiresAt - Date.now()) / 1000);
}

export const DEFAULT_PROXY_MAX_AGE_DAYS = 1;

export function getProxyMaxAgeSeconds(): number {
  const raw = (process.env.POSTER_PROXY_MAX_AGE_DAYS ?? '').trim();
  let days = DEFAULT_PROXY_MAX_AGE_DAYS;
  if (raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) days = parsed;
  }

  const seconds = days > 0
    ? Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(days * 24 * 60 * 60)))
    : MAX_BROWSER_MAX_AGE;

  return seconds;
}

export function getInactiveDays(): number {
  const parsed = parseInt(process.env.POSTER_CACHE_INACTIVE_DAYS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export function getMaxObjectBytes(): number {
  const parsed = parseSize(process.env.POSTER_CACHE_MAX_OBJECT_BYTES);
  return parsed && parsed > 0 ? parsed : 20 * 1024 * 1024;
}

export function getUpstreamTimeoutMs(): number {
  const parsed = parseInt(process.env.POSTER_PROXY_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
}

export const LEGACY_NGINX_CACHE_DIRS = [
  '/var/cache/nginx/posters',
  '/var/cache/nginx',
];

const IMPORT_DISABLED = /^(0|false|no|off|none|disabled)$/i;

export function getNginxImportDir(): string {
  const raw = (process.env.POSTER_CACHE_IMPORT_NGINX_DIR || '').trim();
  return IMPORT_DISABLED.test(raw) ? '' : raw;
}

export function isNginxImportDisabled(): boolean {
  return IMPORT_DISABLED.test((process.env.POSTER_CACHE_IMPORT_NGINX_DIR || '').trim());
}

export function getFetchConcurrency(): number {
  const parsed = parseInt(process.env.POSTER_CACHE_FETCH_CONCURRENCY || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 128;
}

function intEnv(name: string, fallback: number, min: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function getWarmQueueMax(): number {
  return intEnv('IMAGE_WARM_QUEUE_MAX', 50000, 1);
}

export function getWarmConcurrencyMin(): number {
  return intEnv('IMAGE_WARM_CONCURRENCY_MIN', 4, 1);
}

export function getWarmConcurrencyMax(): number {
  return Math.max(getWarmConcurrencyMin(), intEnv('IMAGE_WARM_CONCURRENCY_MAX', 48, 1));
}

export function getWarmTargetLagMs(): number {
  return intEnv('IMAGE_WARM_TARGET_LAG_MS', 20, 1);
}

export function isWarmQueueEnabled(): boolean {
  return !isExplicitlyDisabled(process.env.IMAGE_WARM_QUEUE);
}

export function getStreamThresholdBytes(): number {
  const parsed = parseSize(process.env.POSTER_CACHE_STREAM_THRESHOLD);
  return parsed && parsed > 0 ? parsed : 256 * 1024;
}

/** How long a validated host's pinned addresses and pooled agents are reused. */
export function getConnectionCacheTtlMs(): number {
  const parsed = parseInt(process.env.POSTER_CACHE_AGENT_TTL_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

/** Upper bound on distinct hosts pooled at once — the key is attacker-influenced. */
export function getConnectionCacheMax(): number {
  const parsed = parseInt(process.env.POSTER_CACHE_AGENT_MAX || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 512;
}

export function shouldLogRequests(): boolean {
  return isTruthy(process.env.POSTER_CACHE_LOG_REQUESTS);
}

export function isPrivateArtAllowed(): boolean {
  return !isExplicitlyDisabled(process.env.POSTER_PROXY_ALLOW_PRIVATE);
}

export function getAllowedPrivateHosts(): Set<string> {
  const raw = process.env.POSTER_CACHE_ALLOWED_HOSTS || '';
  return new Set(raw.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}
