import * as path from 'node:path';


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
  return isBuiltinPosterCacheEnabled() ? `${base}/${imageClass}/${url}` : `${base}/${url}`;
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

export const DEFAULT_TTL_DAYS = 30;

export function getEntryTtlDays(): number {
  const raw = (process.env.POSTER_CACHE_TTL_DAYS ?? '').trim();
  if (raw === '') return DEFAULT_TTL_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_TTL_DAYS;
  return parsed;
}

export function getEntryTtlMs(): number {
  const days = getEntryTtlDays();
  return days > 0 ? days * 24 * 60 * 60 * 1000 : Infinity;
}

const MAX_BROWSER_MAX_AGE = 365 * 24 * 60 * 60;

export function getBrowserMaxAgeSeconds(): number {
  const ttl = getEntryTtlMs();
  if (!Number.isFinite(ttl)) return MAX_BROWSER_MAX_AGE;
  return Math.min(MAX_BROWSER_MAX_AGE, Math.max(60, Math.floor(ttl / 1000)));
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

  return isClassEnabled('processed') ? Math.min(seconds, getBrowserMaxAgeSeconds()) : seconds;
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
