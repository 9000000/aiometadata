import { browserMaxAgeFor, getProxyMaxAgeSeconds, isTruthy } from './config.js';

export interface ProxyResponseInput {
  entry?: { expiresAt?: number; etag?: string } | null;
  status?: string | null;
  upstreamHeaders?: Record<string, unknown> | null;
}

export interface ProxyResponseHeaders {
  'Cache-Control': string;
  ETag?: string;
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

export function proxyResponseHeaders(input: ProxyResponseInput = {}): ProxyResponseHeaders {
  const { entry, status, upstreamHeaders } = input;

  if (status === 'BYPASS') return { 'Cache-Control': 'no-store' };

  if (entry) {
    const headers: ProxyResponseHeaders = { 'Cache-Control': ourCacheControl(entry) };
    if (entry.etag) headers.ETag = `"${entry.etag}"`;
    return headers;
  }

  const upstream = followsUpstreamCacheControl() ? upstreamCacheControl(upstreamHeaders) : null;
  return { 'Cache-Control': upstream ?? ourCacheControl() };
}

export function applyProxyResponseHeaders(res: any, input: ProxyResponseInput = {}): string | undefined {
  const headers = proxyResponseHeaders(input);
  res.setHeader('Cache-Control', headers['Cache-Control']);
  if (headers.ETag) res.setHeader('ETag', headers.ETag);
  return headers.ETag;
}
