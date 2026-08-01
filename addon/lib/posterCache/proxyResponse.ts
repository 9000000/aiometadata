import type { ServerResponse } from 'node:http';
import {
  DO_NOT_STORE,
  browserMaxAgeFor,
  clampBrowserMaxAge,
  getBrowserMaxAgeSeconds,
  getProxyMaxAgeSeconds,
  inferFreshnessMs,
  isTruthy,
  parseUpstreamCacheMeta,
  type UpstreamCacheMeta,
} from './config.js';

export type ResponseSurface = 'proxy' | 'direct';

export interface ProxyResponseInput {
  entry?: { expiresAt?: number; etag?: string } | null;
  status?: string | null;
  upstreamHeaders?: Record<string, unknown> | null;
  surface?: ResponseSurface;
  notStorable?: boolean;
}

export interface ProxyResponseHeaders {
  'Cache-Control': string;
  ETag?: string;
  'Last-Modified'?: string;
  Age?: string;
}

function withoutWeakPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
}

export function etagMatches(ifNoneMatch: unknown, etag: string | undefined): boolean {
  if (typeof ifNoneMatch !== 'string' || !etag) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const target = withoutWeakPrefix(etag);
  const candidates = ifNoneMatch.match(/(?:W\/)?"[^"]*"/g) || [];
  return candidates.some((candidate) => withoutWeakPrefix(candidate) === target);
}

export function followsUpstreamCacheControl(): boolean {
  return isTruthy(process.env.POSTER_PROXY_FOLLOW_UPSTREAM);
}

function ourCacheControl(entry?: ProxyResponseInput['entry']): string {
  let maxAge = getProxyMaxAgeSeconds();
  if (entry && Number.isFinite(entry.expiresAt)) {
    maxAge = Math.min(maxAge, browserMaxAgeFor(entry.expiresAt as number));
  }
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`;
}

function upstreamCacheControl(headers: ProxyResponseInput['upstreamHeaders']): string | null {
  const raw = headers?.['cache-control'];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

function upstreamValidators(upstream: UpstreamCacheMeta): Partial<ProxyResponseHeaders> {
  const out: Partial<ProxyResponseHeaders> = {};
  if (upstream.etag) out.ETag = upstream.etag;
  if (upstream.lastModified) out['Last-Modified'] = upstream.lastModified;
  return out;
}

function upstreamAge(upstream: UpstreamCacheMeta): string | undefined {
  return upstream.age === undefined ? undefined : String(upstream.age);
}

function lifetime(maxAge: number): string {
  return `public, max-age=${maxAge}, stale-while-revalidate=${maxAge}`;
}

/**
 * How long a passed-through image may be reused.
 *
 * This branch is reached only for art we are **not** storing, so for these bytes
 * the addon is a plain proxy and the provider is the authority on how long its
 * own art stays good. Inventing a flat figure here was how a rating poster —
 * whose URL names a slot rather than a file — came to be advertised for a day
 * after the rating behind it had already changed.
 *
 * Bounded, not verbatim. `POSTER_PROXY_MAX_AGE_DAYS` is the ceiling, so no
 * provider can pin its art in the operator's CDN, and a one-minute floor stops a
 * whole catalogue revalidating on every single request. A provider that promises
 * nothing still gets the operator's figure. `POSTER_PROXY_FOLLOW_UPSTREAM` is the
 * separate, unclamped escape hatch for operators who want the header verbatim.
 *
 * Provider policies are deliberately not consulted: they decide what the store
 * keeps, and nothing is being kept here. See `resolveEntryTtlMs` for the
 * storage side.
 */
function passThroughCacheControl(upstream: UpstreamCacheMeta): string {
  const ceiling = getProxyMaxAgeSeconds();

  const inferred = inferFreshnessMs(upstream);
  // The origin refuses storage outright, so nothing downstream may keep it.
  if (inferred === DO_NOT_STORE) return 'no-store';
  // Reuse requires revalidating first, so no lifetime applies. Checked separately
  // from the inference because `inferFreshnessMs` answers `null` — not 0 — for a
  // `no-cache` response that carried no validator, which would otherwise fall
  // straight through to the full ceiling.
  if (upstream.noCache) return 'public, no-cache';

  // `null` means the provider promised nothing we can act on, so our figure stands.
  const maxAge = inferred === null ? ceiling : Math.min(ceiling, clampBrowserMaxAge(inferred / 1000));
  // A stale window is exactly what `must-revalidate` forbids.
  if (upstream.mustRevalidate) return `public, max-age=${maxAge}, must-revalidate`;
  return lifetime(maxAge);
}

export function proxyResponseHeaders(input: ProxyResponseInput = {}): ProxyResponseHeaders {
  const { entry, status, upstreamHeaders, surface = 'proxy', notStorable } = input;

  if (status === 'BYPASS') {
    const headers: ProxyResponseHeaders = { 'Cache-Control': 'no-store' };
    if (entry?.etag) headers.ETag = `"${entry.etag}"`;
    return headers;
  }

  if (entry) {
    const headers: ProxyResponseHeaders = {
      'Cache-Control': surface === 'direct'
        ? `public, max-age=${browserMaxAgeFor(entry.expiresAt as number)}`
        : ourCacheControl(entry),
    };
    if (entry.etag) headers.ETag = `"${entry.etag}"`;
    return headers;
  }

  if (surface === 'direct') {
    return { 'Cache-Control': notStorable ? 'no-store' : `public, max-age=${getBrowserMaxAgeSeconds()}` };
  }

  const upstream = parseUpstreamCacheMeta((upstreamHeaders ?? {}) as Record<string, any>);
  const followed = followsUpstreamCacheControl() ? upstreamCacheControl(upstreamHeaders) : null;
  const headers: ProxyResponseHeaders = {
    'Cache-Control': followed ?? passThroughCacheControl(upstream),
    ...upstreamValidators(upstream),
  };
  if (followed) {
    const age = upstreamAge(upstream);
    if (age) headers.Age = age;
  }
  return headers;
}

export type ProxyResponseTarget = Pick<ServerResponse, 'setHeader'>;

export function applyProxyResponseHeaders(res: ProxyResponseTarget, input: ProxyResponseInput = {}): string | undefined {
  const headers = proxyResponseHeaders(input);
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) res.setHeader(name, value);
  }
  return headers.ETag;
}
