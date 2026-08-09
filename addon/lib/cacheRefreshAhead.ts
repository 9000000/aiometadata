export {};

const redis: any = require('./redisClient');
const consola: any = require('consola');
const { getSetting }: any = require('./settingsService');

const logger = consola.withTag('Refresh-Ahead');

const LOCK_SECONDS = 300;
const DEFAULT_FRACTION = 0.1;
const DEFAULT_MAX_CONCURRENT = 3;

const inFlight = new Set<string>();
let activeCount = 0;

const stats = { started: 0, succeeded: 0, skipped: 0, failed: 0 };

function isRefreshAheadEnabled(): boolean {
  try {
    return getSetting('CATALOG_REFRESH_AHEAD_ENABLED') !== 'false';
  } catch {
    return false;
  }
}

function fraction(): number {
  const parsed = Number.parseFloat(getSetting('CATALOG_REFRESH_AHEAD_FRACTION'));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0.5) return DEFAULT_FRACTION;
  return parsed;
}

function maxConcurrent(): number {
  const parsed = Number.parseInt(getSetting('CATALOG_REFRESH_AHEAD_MAX_CONCURRENT'), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT;
  return parsed;
}

function isDueForRefresh(pttlMs: number, ttlSeconds: number): boolean {
  if (!Number.isFinite(pttlMs) || pttlMs <= 0) return false;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
  return pttlMs < ttlSeconds * 1000 * fraction();
}

function countItems(value: any): number | null {
  if (value && Array.isArray(value.metas)) return value.metas.length;
  if (Array.isArray(value)) return value.length;
  if (value && value.meta && typeof value.meta === 'object') {
    return Object.keys(value.meta).length > 0 ? 1 : 0;
  }
  return null;
}

function mayReplaceOnRefresh(existing: any, incoming: any): boolean {
  const had = countItems(existing);
  const has = countItems(incoming);
  if (had === null || has === null) return true;
  return !(had > 0 && has === 0);
}

async function runRefreshAhead(versionedKey: string, rebuild: () => Promise<boolean>): Promise<void> {
  if (inFlight.has(versionedKey)) {
    stats.skipped += 1;
    return;
  }
  if (activeCount >= maxConcurrent()) {
    stats.skipped += 1;
    return;
  }

  inFlight.add(versionedKey);
  activeCount += 1;

  try {
    const acquired = await redis.set(`${versionedKey}:refresh-lock`, '1', 'EX', LOCK_SECONDS, 'NX');
    if (!acquired) {
      stats.skipped += 1;
      return;
    }

    stats.started += 1;
    const wrote = await rebuild();
    if (wrote) {
      stats.succeeded += 1;
      logger.debug(`Rebuilt ${versionedKey} off the request path`);
    } else {
      stats.skipped += 1;
    }
  } catch (error: any) {
    stats.failed += 1;
    logger.warn(`Refresh failed for ${versionedKey}: ${error?.message}`);
  } finally {
    inFlight.delete(versionedKey);
    activeCount -= 1;
  }
}

function getRefreshAheadStats(): any {
  return { ...stats };
}

function resetRefreshAheadStats(): void {
  stats.started = 0;
  stats.succeeded = 0;
  stats.skipped = 0;
  stats.failed = 0;
}

function __resetForTests(): void {
  inFlight.clear();
  activeCount = 0;
}

module.exports = {
  isRefreshAheadEnabled,
  isDueForRefresh,
  mayReplaceOnRefresh,
  runRefreshAhead,
  getRefreshAheadStats,
  resetRefreshAheadStats,
  __resetForTests,
};
