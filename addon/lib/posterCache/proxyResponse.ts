import type { ServerResponse } from 'node:http';
import {
  DO_NOT_STORE,
  browserMaxAgeFor,
  clampBrowserMaxAge,
  getBrowserMaxAgeSeconds,
  getProxyMaxAgeSeconds,
  inferClientFreshnessMs,
  isTruthy,
  parseUpstreamCacheMeta,
  type UpstreamCacheMeta,
} from './config.js';

export type ResponseSurface = 'proxy' | 'direct';

export interface ProxyResponseInput {
  entry?: { expiresAt?: number; etag?: string; upstream?: UpstreamCacheMeta } | null;
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

interface ClientTerms {
  /** The provider's answer for a browser is terminal — no lifetime applies. */
  verdict?: string;
  maxAge: number;
  mustRevalidate: boolean;
}

/**
 * Bounds a lifetime by what the origin offered a *browser*, which is a
 * different question from what it offered us. Only `Cache-Control` is read
 * here: `s-maxage` and `CDN-Cache-Control` address shared caches, and this
 * header is handed to a private one.
 */
function clientTerms(
  upstream: UpstreamCacheMeta | undefined,
  maxAge: number,
  revalidatable = false
): ClientTerms {
  const client = inferClientFreshnessMs(upstream, revalidatable);
  if (client === DO_NOT_STORE) return { verdict: 'no-store', maxAge, mustRevalidate: false };
  // Reuse requires revalidating first, so no lifetime applies. Checked separately
  // from the inference because `inferClientFreshnessMs` answers `null` — not 0 —
  // for a `no-cache` response that carried no validator, which would otherwise
  // fall straight through to the full ceiling.
  if (upstream?.noCache) return { verdict: 'public, no-cache', maxAge, mustRevalidate: false };
  return {
    maxAge: client === null ? maxAge : Math.min(maxAge, clampBrowserMaxAge(client / 1000)),
    mustRevalidate: !!upstream?.mustRevalidate,
  };
}

/** `stale` adds the revalidation window; `must-revalidate` is what forbids one. */
function renderTerms(terms: ClientTerms, stale: boolean): string {
  if (terms.verdict) return terms.verdict;
  if (terms.mustRevalidate) return `public, max-age=${terms.maxAge}, must-revalidate`;
  return stale ? lifetime(terms.maxAge) : `public, max-age=${terms.maxAge}`;
}

/**
 * How long a client may reuse an image we are holding.
 *
 * Two bounds, not one. `expiresAt` is how long *we* may reuse these bytes,
 * which under a targeted `CDN-Cache-Control` is legitimately longer than
 * anything the provider offered a browser; the provider's browser-facing terms
 * bound the figure again. Serving the store's own validity alone is what would
 * hand a browser five minutes of a rating poster the provider had told it to
 * revalidate every time.
 */
function ourCacheControl(entry?: ProxyResponseInput['entry']): string {
  let maxAge = getProxyMaxAgeSeconds();
  if (entry && Number.isFinite(entry.expiresAt)) {
    maxAge = Math.min(maxAge, browserMaxAgeFor(entry.expiresAt as number));
  }
  return renderTerms(clientTerms(entry?.upstream, maxAge, !!entry?.etag), true);
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
 * Browser-facing throughout — see `clientTerms`. A `CDN-Cache-Control` on the
 * way in was addressed to the store, not to the client this header reaches.
 *
 * Provider policies are deliberately not consulted: they decide what the store
 * keeps, and nothing is being kept here. See `resolveEntryTtlMs` for the
 * storage side.
 */
function passThroughCacheControl(upstream: UpstreamCacheMeta): string {
  // `POSTER_PROXY_MAX_AGE_DAYS` is the ceiling, and stands on its own where the
  // provider promised a browser nothing we can act on.
  return renderTerms(clientTerms(upstream, getProxyMaxAgeSeconds()), true);
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
      // The direct surface is not behind the operator's CDN, so it carries
      // neither the proxy ceiling nor a stale window — but the same audience
      // reads it, so the origin's browser-facing terms bound it just the same.
      'Cache-Control': surface === 'direct'
        ? renderTerms(clientTerms(entry.upstream, browserMaxAgeFor(entry.expiresAt as number), !!entry.etag), false)
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
