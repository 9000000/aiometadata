import { pipeline } from 'node:stream/promises';
import { ingestExternalLog } from '../logBuffer.js';
import {
  POSTER_CACHE_ROUTE,
  URL_ADDRESSABLE_CLASSES,
  getBrowserMaxAgeSeconds,
  isBuiltinPosterCacheEnabled,
  isClassEnabled,
  shouldLogRequests,
  type ImageClass,
} from './config.js';
import * as store from './store.js';
import { OversizeImage, UpstreamRejected, fetchImage, openImageStream } from './upstream.js';

const SERVICE = 'poster-cache';

/**
 * Reconstructs the upstream URL from the request path, reusing the two patterns
 * the nginx `map` block used. The second exists because reverse proxies such as
 * Traefik collapse "https://" to "https:/" when normalizing paths.
 */
const COLLAPSED_SCHEME = /^\/(https?):\/([^/].*)$/;
const FULL_SCHEME = /^\/(https?:\/\/.*)$/;

const CLASS_SEGMENT = new RegExp(`^/(${URL_ADDRESSABLE_CLASSES.join('|')})(/.*)$`);

const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const negativeCache = new Map<string, { until: number; status: number; message: string }>();

const NEGATIVE_CACHE_MAX = 5000;

function rememberFailure(key: string, status: number, message: string): void {
  negativeCache.set(key, { until: Date.now() + NEGATIVE_TTL_MS, status, message });
  if (negativeCache.size <= NEGATIVE_CACHE_MAX) return;

  const now = Date.now();
  for (const [entryKey, entry] of negativeCache) {
    if (entry.until <= now) negativeCache.delete(entryKey);
  }
  
  for (const entryKey of negativeCache.keys()) {
    if (negativeCache.size <= NEGATIVE_CACHE_MAX) break;
    negativeCache.delete(entryKey);
  }
}

function recentFailure(key: string): { status: number; message: string } | null {
  const entry = negativeCache.get(key);
  if (!entry) return null;
  if (entry.until <= Date.now()) {
    negativeCache.delete(key);
    return null;
  }
  return entry;
}

export interface ParsedRequest {
  imageClass: ImageClass;
  url: string;
}


export function parsePosterCachePath(pathAfterMount: string): ParsedRequest | null {
  let imageClass: ImageClass = 'poster';
  let remainder = pathAfterMount;

  const classMatch = CLASS_SEGMENT.exec(remainder);
  if (classMatch) {
    imageClass = classMatch[1] as ImageClass;
    remainder = classMatch[2];
  }

  const collapsed = COLLAPSED_SCHEME.exec(remainder);
  if (collapsed) return { imageClass, url: `${collapsed[1]}://${collapsed[2]}` };

  const full = FULL_SCHEME.exec(remainder);
  if (full) return { imageClass, url: full[1] };

  return null;
}

function log(level: number, message: string): void {
  try {
    ingestExternalLog({ service: SERVICE, level, message });
  } catch {
    /* logging must never break image delivery */
  }
}

const SUMMARY_INTERVAL_MS = 60_000;
const counters = { HIT: 0, MISS: 0, STALE: 0, BYPASS: 0, errors: 0, bytes: 0 };
let summaryTimer: NodeJS.Timeout | null = null;

function record(status: string, bytes = 0): void {
  if (status in counters) (counters as any)[status] += 1;
  counters.bytes += bytes;
  ensureSummaryTimer();
}

function recordError(): void {
  counters.errors += 1;
  ensureSummaryTimer();
}

function ensureSummaryTimer(): void {
  if (summaryTimer) return;
  summaryTimer = setInterval(() => {
    const total = counters.HIT + counters.MISS + counters.STALE + counters.BYPASS;
    if (total === 0 && counters.errors === 0) return;
    const mb = (counters.bytes / 1024 / 1024).toFixed(1);
    const hitRate = total > 0 ? Math.round((counters.HIT / total) * 100) : 0;
    log(3, `served ${total} images (${hitRate}% hit) — ${counters.HIT} hit, ${counters.MISS} miss, ` +
           `${counters.STALE} stale, ${counters.BYPASS} bypass, ${counters.errors} errors, ${mb} MB`);
    counters.HIT = counters.MISS = counters.STALE = counters.BYPASS = counters.errors = 0;
    counters.bytes = 0;
  }, SUMMARY_INTERVAL_MS);
  summaryTimer.unref?.();
}

export function recordServe(imageClass: ImageClass, status: string, bytes: number, method: string, url: string): void {
  record(status, bytes);
  if (shouldLogRequests()) log(3, `${method} ${imageClass} ${status} ${url}`);
}

export function recordServeError(): void {
  recordError();
}

/** A client revalidated and got a 304 — a hit that sends no bytes. */
export function recordRevalidated(imageClass: ImageClass, method: string, url: string): void {
  record('HIT');
  if (shouldLogRequests()) log(3, `${method} ${imageClass} HIT 304 ${url}`);
}

const CLAIMED = Symbol('poster-cache-claimed');
function claimStream(stream: any): boolean {
  if (stream[CLAIMED]) return true;
  stream[CLAIMED] = true;
  return false;
}

async function pipeStream(
  req: any,
  res: any,
  body: NodeJS.ReadableStream,
  contentType: string,
  imageClass: ImageClass,
  url: string
): Promise<void> {
  res.setHeader('X-Cache-Status', 'BYPASS');
  res.setHeader('Cache-Control', `public, max-age=${getBrowserMaxAgeSeconds()}`);
  res.setHeader('Content-Type', contentType || 'image/jpeg');
  record('BYPASS');
  if (shouldLogRequests()) log(3, `${req.method} ${imageClass} BYPASS ${url}`);

  if (req.method === 'HEAD') {
    (body as any).destroy?.();
    res.status(200).end();
    return;
  }

  res.status(200);
  await pipeline(body, res);
}

async function passThrough(req: any, res: any, url: string, imageClass: ImageClass): Promise<void> {
  const { response, contentType } = await openImageStream(url);
  await pipeStream(req, res, response.data, contentType, imageClass, url);
}

export function posterCacheHandler() {
  return async function handle(req: any, res: any, next: any): Promise<void> {
    if (!isBuiltinPosterCacheEnabled()) {
      return next();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }

    const mountIndex = req.originalUrl.indexOf(POSTER_CACHE_ROUTE);
    const pathAfterMount = mountIndex >= 0
      ? req.originalUrl.slice(mountIndex + POSTER_CACHE_ROUTE.length)
      : req.originalUrl;

    const parsed = parsePosterCachePath(pathAfterMount);
    if (!parsed) {
      res.status(400).json({ error: 'Expected /poster-cache/[class/]<absolute-image-url>' });
      return;
    }

    const { imageClass, url } = parsed;
    const cacheKey = url;
    const negative = recentFailure(cacheKey);
    if (negative) {
      res.setHeader('X-Cache-Status', 'MISS');
      res.status(negative.status).json({ error: negative.message });
      return;
    }

    const shouldStore = isClassEnabled(imageClass);
    const logRequests = shouldLogRequests();

    try {
      if (!shouldStore) {
        await passThrough(req, res, url, imageClass);
        return;
      }

      let entry: store.CacheEntry;
      let status: string;
      try {
        const result = await store.getOrFetch(imageClass, cacheKey, () => fetchImage(url));
        entry = result.entry;
        status = result.status;
      } catch (error: any) {
        if (error instanceof OversizeImage) {
          const stream: any = error.stream;
          if (stream && !stream.destroyed && !stream.readableEnded && !claimStream(stream)) {
            await pipeStream(req, res, stream, error.contentType, imageClass, url);
          } else {
            await passThrough(req, res, url, imageClass);
          }
          return;
        }
        throw error;
      }

      const etag = `"${entry.etag}"`;
      res.setHeader('ETag', etag);
      res.setHeader('X-Cache-Status', status);
      res.setHeader('Cache-Control', `public, max-age=${getBrowserMaxAgeSeconds()}`);
      res.setHeader('Content-Type', entry.contentType || 'image/jpeg');

      if (req.headers['if-none-match'] === etag) {
        record(status);
        if (logRequests) log(3, `${req.method} ${imageClass} ${status} 304 ${url}`);
        res.status(304).end();
        return;
      }

      res.setHeader('Content-Length', String(entry.size));
      record(status, entry.size);
      if (logRequests) log(3, `${req.method} ${imageClass} ${status} ${entry.size} ${url}`);

      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }

      res.status(200);
      if (entry.body) {
        res.end(entry.body);
      } else {
        // Large entry: streamed off disk rather than buffered.
        await pipeline(entry.openStream!(), res);
      }
    } catch (error: any) {
      const status = error instanceof UpstreamRejected ? error.status : 502;
      const message = error?.message || 'Poster cache error';
      rememberFailure(cacheKey, status, message);
      recordError();
      // Errors are always logged: they are rare and are what an operator needs.
      log(status >= 500 ? 0 : 1, `${req.method} ${imageClass} ERROR ${status} ${url} — ${message}`);
      if (!res.headersSent) {
        res.status(status).json({ error: message });
      } else {
        res.end();
      }
    }
  };
}
