const consola: any = require('consola');
const redis: any = require('./redisClient');
const { encodeCachePayload, decodeCachePayload }: any = require('./cacheCodec');

const { LRUCache } = require('lru-cache');

const logger: any = consola.withTag('ConfigCache');

function parsePositiveIntEnv(envValue: string | undefined, defaultValue: number, minValue: number = 1): number {
  const parsed = Number.parseInt(String(envValue), 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return defaultValue;
  return parsed;
}

function CONFIG_CACHE_TTL_SEC() { return parsePositiveIntEnv(process.env.CONFIG_CACHE_TTL_SEC, 300, 10); }
function isConfigCacheCompressionEnabled(): boolean {
  return process.env.CONFIG_CACHE_COMPRESSION_ENABLED !== 'false';
}
const KEY_PREFIX = 'user-config:';

function redisKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

const pendingLoads = new Map<string, Promise<any>>();

// L1 Memory Cache: Caches user config in RAM for 60s to prevent dozens of duplicate Redis queries per catalog
const l1ConfigCache = new LRUCache({
  max: 1000,
  ttl: 60 * 1000, // 60 seconds
});

class ConfigCache {
  async get(key: string): Promise<any> {
    const rKey = redisKey(key);
    const inMem = l1ConfigCache.get(rKey);
    if (inMem !== undefined) return inMem;

    if (!redis || redis.status !== 'ready') return null;
    try {
      const raw = await redis.getBuffer(rKey);
      const decoded = raw ? await decodeCachePayload(raw) : null;
      if (decoded !== null && decoded !== undefined) {
        l1ConfigCache.set(rKey, decoded);
      }
      return decoded;
    } catch (err: any) {
      logger.warn(`get failed for ${String(key).substring(0, 8)}...: ${err.message}`);
      return null;
    }
  }

  async set(key: string, value: any): Promise<void> {
    if (value === undefined) return;
    const rKey = redisKey(key);
    l1ConfigCache.set(rKey, value);

    if (!redis || redis.status !== 'ready') return;
    try {
      const payload = await encodeCachePayload(value, {
        compressionEnabled: isConfigCacheCompressionEnabled(),
      });
      await redis.set(rKey, payload, 'EX', CONFIG_CACHE_TTL_SEC());
    } catch (err: any) {
      logger.warn(`set failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async del(key: string): Promise<void> {
    const rKey = redisKey(key);
    pendingLoads.delete(rKey);
    l1ConfigCache.delete(rKey);
    if (!redis || redis.status !== 'ready') return;
    try {
      await redis.del(rKey);
    } catch (err: any) {
      logger.warn(`del failed for ${String(key).substring(0, 8)}...: ${err.message}`);
    }
  }

  async clear(): Promise<void> {
    pendingLoads.clear();
    l1ConfigCache.clear();
    if (!redis || redis.status !== 'ready') return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== '0');
    } catch (err: any) {
      logger.warn(`clear failed: ${err.message}`);
    }
  }

  async getOrLoad(key: string, loader: () => Promise<any>): Promise<any> {
    if (!redis || redis.status !== 'ready') return loader();

    const cached = await this.get(key);
    if (cached !== null) return cached;

    const mapKey = redisKey(key);
    const existing = pendingLoads.get(mapKey);
    if (existing) {
      logger.debug(`Config load already in progress for ${String(key).substring(0, 8)}..., waiting`);
      return existing;
    }

    const loadPromise = (async () => {
      try {
        const value = await loader();
        if (value !== undefined && value !== null) {
          this.set(key, value).catch((err: any) => logger.warn(`Background set failed: ${err.message}`));
        }
        return value;
      } finally {
        pendingLoads.delete(mapKey);
      }
    })();

    pendingLoads.set(mapKey, loadPromise);
    return loadPromise;
  }

  isLoadPending(key: string): boolean {
    return pendingLoads.has(redisKey(key));
  }

  getMemoryStats(): { pendingLoads: number } {
    return { pendingLoads: pendingLoads.size };
  }

  async stats({ countRedisEntries = false } = {}): Promise<{ pendingLoads: number; entries: number | null }> {
    const out: { pendingLoads: number; entries: number | null } = { pendingLoads: pendingLoads.size, entries: null };
    if (!countRedisEntries || !redis || redis.status !== 'ready') return out;
    try {
      let cursor = '0';
      let total = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 500);
        cursor = next;
        total += keys.length;
      } while (cursor !== '0');
      out.entries = total;
    } catch (err: any) {
      logger.warn(`stats SCAN failed: ${err.message}`);
    }
    return out;
  }
}

const configCache = new ConfigCache();

if (redis) {
  logger.debug(`ConfigCache backed by Redis, TTL=${CONFIG_CACHE_TTL_SEC()}s`);
} else {
  logger.warn('ConfigCache: Redis unavailable, falling through to loader on every call');
}

export { configCache as default };
module.exports = configCache;
