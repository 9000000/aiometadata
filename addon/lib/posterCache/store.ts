import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import consola from 'consola';
import {
  IMAGE_CLASSES,
  formatSize,
  getCacheDir,
  getEntryTtlDays,
  getEntryTtlMs,
  getInactiveDays,
  getMaxBytes,
  getMaxSizeRaw,
  getMemoryBudget,
  getMemorySizeRaw,
  getStreamThresholdBytes,
  type ImageClass,
} from './config.js';

const logger = consola.withTag('PosterCache');

const MAGIC = Buffer.from('AIOM1', 'ascii');
const HEADER_OFFSET = MAGIC.length + 4;

const ACCESS_TOUCH_MS = 6 * 60 * 60 * 1000;

function isExpired(storedAt: number): boolean {
  return Date.now() - storedAt > getEntryTtlMs();
}

export interface EntryHeader {
  key: string;
  contentType: string;
  size: number;
  storedAt: number;
  bodyHash?: string;
}

export interface CacheEntry {
  contentType: string;
  storedAt: number;
  expired: boolean;
  hash: string;
  etag: string;
  size: number;
  body?: Buffer;
  openStream?: () => NodeJS.ReadableStream;
}

interface IndexEntry {
  imageClass: ImageClass;
  hash: string;
  size: number;
  lastAccess: number;
}

interface ClassTotals {
  count: number;
  bytes: number;
}

const index = new Map<string, IndexEntry>();
const classTotals = new Map<ImageClass, ClassTotals>();
const inflight = new Map<string, Promise<FetchResult>>();


interface MemoryEntry {
  body: Buffer;
  contentType: string;
  storedAt: number;
  etag: string;
}
const memory = new Map<string, MemoryEntry>();
let memoryBytes = 0;
let memoryHits = 0;

let initialized = false;
let scanning = false;
let evicting = false;
let sweepTimer: NodeJS.Timeout | null = null;

function indexKey(imageClass: ImageClass, hash: string): string {
  return `${imageClass}/${hash}`;
}

function totalsFor(imageClass: ImageClass): ClassTotals {
  let totals = classTotals.get(imageClass);
  if (!totals) {
    totals = { count: 0, bytes: 0 };
    classTotals.set(imageClass, totals);
  }
  return totals;
}

function addToIndex(entry: IndexEntry): void {
  const key = indexKey(entry.imageClass, entry.hash);
  const existing = index.get(key);
  const totals = totalsFor(entry.imageClass);
  if (existing) {
    totals.bytes -= existing.size;
    totals.count -= 1;
  }
  index.set(key, entry);
  totals.bytes += entry.size;
  totals.count += 1;
}

function removeFromIndex(imageClass: ImageClass, hash: string): number {
  const key = indexKey(imageClass, hash);
  const existing = index.get(key);
  if (!existing) return 0;
  index.delete(key);
  const totals = totalsFor(imageClass);
  totals.bytes -= existing.size;
  totals.count -= 1;
  if (totals.bytes < 0) totals.bytes = 0;
  if (totals.count < 0) totals.count = 0;
  return existing.size;
}

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function hashBody(body: Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}


function legacyEtag(hash: string, storedAt: number): string {
  return `${hash.slice(0, 32)}-${storedAt.toString(36)}`;
}

// --- In-memory tier ---

function memoryTake(key: string): MemoryEntry | undefined {
  const hit = memory.get(key);
  if (!hit) return undefined;
  memory.delete(key);
  memory.set(key, hit);
  memoryHits += 1;
  return hit;
}

function memoryDrop(key: string): void {
  const existing = memory.get(key);
  if (!existing) return;
  memory.delete(key);
  memoryBytes -= existing.body.length;
  if (memoryBytes < 0) memoryBytes = 0;
}

function memoryPut(key: string, body: Buffer, contentType: string, storedAt: number, etag: string): void {
  const budget = getMemoryBudget();
  if (budget <= 0) return;
  if (body.length > getStreamThresholdBytes()) return;
  if (body.length > budget) return;

  memoryDrop(key);
  memory.set(key, { body, contentType, storedAt, etag });
  memoryBytes += body.length;

  while (memoryBytes > budget) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memoryDrop(oldest.value);
  }
}

function memoryClear(prefix?: string): void {
  if (!prefix) {
    memory.clear();
    memoryBytes = 0;
    return;
  }
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memoryDrop(key);
  }
}

function entryPath(imageClass: ImageClass, hash: string): string {
  return path.join(getCacheDir(), imageClass, hash.slice(0, 2), hash.slice(2, 4), hash);
}

function totalBytes(): number {
  let sum = 0;
  for (const totals of classTotals.values()) sum += totals.bytes;
  return sum;
}

function totalCount(): number {
  let sum = 0;
  for (const totals of classTotals.values()) sum += totals.count;
  return sum;
}

function encode(header: EntryHeader, body: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(headerJson.length, 0);
  return Buffer.concat([MAGIC, lengthPrefix, headerJson, body]);
}

const HEADER_PROBE_BYTES = 8192;

function readFraming(probe: Buffer): { headerLen: number; bodyOffset: number } | null {
  if (probe.length < HEADER_OFFSET) return null;
  if (!probe.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const headerLen = probe.readUInt32BE(MAGIC.length);
  if (headerLen <= 0 || headerLen > HEADER_PROBE_BYTES * 8) return null;
  return { headerLen, bodyOffset: HEADER_OFFSET + headerLen };
}

export async function get(imageClass: ImageClass, key: string): Promise<CacheEntry | null> {
  const hash = hashKey(key);
  const file = entryPath(imageClass, hash);
  const idxKey = indexKey(imageClass, hash);

  const cached = memoryTake(idxKey);
  if (cached) {
    touch(imageClass, hash, file, index.get(idxKey)?.size ?? cached.body.length);
    return {
      contentType: cached.contentType,
      storedAt: cached.storedAt,
      expired: isExpired(cached.storedAt),
      hash,
      etag: cached.etag,
      size: cached.body.length,
      body: cached.body,
    };
  }

  const known = index.get(idxKey);
  if (!known || known.size <= getStreamThresholdBytes()) {
    return readBuffered(imageClass, hash, file);
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.debug(`open failed for ${imageClass}/${hash}: ${error?.message}`);
    }
    return null;
  }

  try {
    const stat = await handle.stat();
    const probeLength = Math.min(HEADER_PROBE_BYTES, stat.size);
    const probe = Buffer.alloc(probeLength);
    await handle.read(probe, 0, probeLength, 0);

    const framing = readFraming(probe);
    if (!framing) {
      logger.warn(`Discarding corrupt cache entry ${imageClass}/${hash}`);
      await handle.close();
      await remove(imageClass, hash);
      return null;
    }

    let headerJson: Buffer;
    if (framing.bodyOffset <= probeLength) {
      headerJson = probe.subarray(HEADER_OFFSET, framing.bodyOffset);
    } else {
      headerJson = Buffer.alloc(framing.headerLen);
      await handle.read(headerJson, 0, framing.headerLen, HEADER_OFFSET);
    }

    let header: EntryHeader;
    try {
      header = JSON.parse(headerJson.toString('utf8'));
    } catch {
      logger.warn(`Discarding cache entry with unreadable header ${imageClass}/${hash}`);
      await handle.close();
      await remove(imageClass, hash);
      return null;
    }

    const bodySize = stat.size - framing.bodyOffset;
    touch(imageClass, hash, file, stat.size);

    const meta = {
      contentType: header.contentType,
      storedAt: header.storedAt,
      expired: isExpired(header.storedAt),
      hash,
      etag: header.bodyHash || legacyEtag(hash, header.storedAt),
      size: bodySize,
    };

    if (bodySize > getStreamThresholdBytes()) {
      await handle.close();
      return {
        ...meta,
        openStream: () => fs.createReadStream(file, { start: framing.bodyOffset }),
      };
    }

    const body = Buffer.alloc(bodySize);
    if (bodySize > 0) {
      await handle.read(body, 0, bodySize, framing.bodyOffset);
    }
    await handle.close();
    return { ...meta, body };
  } catch (error: any) {
    await handle.close().catch(() => { /* already closing */ });
    logger.debug(`read failed for ${imageClass}/${hash}: ${error?.message}`);
    return null;
  }
}

async function readBuffered(imageClass: ImageClass, hash: string, file: string): Promise<CacheEntry | null> {
  let raw: Buffer;
  try {
    raw = await fsp.readFile(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.debug(`read failed for ${imageClass}/${hash}: ${error?.message}`);
    }
    return null;
  }

  const framing = readFraming(raw);
  if (!framing || framing.bodyOffset > raw.length) {
    logger.warn(`Discarding corrupt cache entry ${imageClass}/${hash}`);
    await remove(imageClass, hash);
    return null;
  }

  let header: EntryHeader;
  try {
    header = JSON.parse(raw.subarray(HEADER_OFFSET, framing.bodyOffset).toString('utf8'));
  } catch {
    logger.warn(`Discarding cache entry with unreadable header ${imageClass}/${hash}`);
    await remove(imageClass, hash);
    return null;
  }

  touch(imageClass, hash, file, raw.length);
  const body = raw.subarray(framing.bodyOffset);
  const etag = header.bodyHash || hashBody(body);
  memoryPut(indexKey(imageClass, hash), body, header.contentType, header.storedAt, etag);

  return {
    contentType: header.contentType,
    storedAt: header.storedAt,
    expired: isExpired(header.storedAt),
    hash,
    etag,
    size: body.length,
    body,
  };
}

function touch(imageClass: ImageClass, hash: string, file: string, size: number): void {
  const now = Date.now();
  const existing = index.get(indexKey(imageClass, hash));
  if (existing) {
    if (now - existing.lastAccess < ACCESS_TOUCH_MS) {
      existing.lastAccess = now;
      return;
    }
    existing.lastAccess = now;
  } else {
    addToIndex({ imageClass, hash, size, lastAccess: now });
  }
  const seconds = now / 1000;
  fsp.utimes(file, seconds, seconds).catch(() => { /* best effort */ });
}

export async function put(
  imageClass: ImageClass,
  key: string,
  body: Buffer,
  contentType: string
): Promise<string> {
  const hash = hashKey(key);
  const file = entryPath(imageClass, hash);
  const bodyHash = hashBody(body);
  const header: EntryHeader = {
    key,
    contentType: contentType || 'image/jpeg',
    size: body.length,
    storedAt: Date.now(),
    bodyHash,
  };
  const payload = encode(header, body);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, file);
  } catch (error: any) {
    logger.warn(`Failed to store ${imageClass} entry: ${error?.message}`);
    await fsp.unlink(tmp).catch(() => { /* nothing to clean up */ });
    // The bytes are still valid to serve even though they were not persisted.
    return bodyHash;
  }

  addToIndex({ imageClass, hash, size: payload.length, lastAccess: Date.now() });
  memoryPut(indexKey(imageClass, hash), body, header.contentType, header.storedAt, bodyHash);
  scheduleEviction();
  return bodyHash;
}

async function remove(imageClass: ImageClass, hash: string): Promise<number> {
  const freed = removeFromIndex(imageClass, hash);
  memoryDrop(indexKey(imageClass, hash));
  await fsp.unlink(entryPath(imageClass, hash)).catch(() => { /* already gone */ });
  return freed;
}

export type CacheStatus = 'HIT' | 'MISS' | 'STALE';

export interface FetchResult {
  entry: CacheEntry;
  status: CacheStatus;
}


export async function getOrFetch(
  imageClass: ImageClass,
  key: string,
  producer: () => Promise<{ body: Buffer; contentType: string }>
): Promise<FetchResult> {
  const cached = await get(imageClass, key);
  if (cached && !cached.expired) return { entry: cached, status: 'HIT' };

  const lockKey = indexKey(imageClass, hashKey(key));
  const existing = inflight.get(lockKey);
  if (existing) return existing;

  const task = (async (): Promise<FetchResult> => {
    try {
      const produced = await producer();
      const etag = await put(imageClass, key, produced.body, produced.contentType);
      return {
        entry: {
          body: produced.body,
          contentType: produced.contentType,
          storedAt: Date.now(),
          expired: false,
          hash: hashKey(key),
          etag,
          size: produced.body.length,
        },
        status: 'MISS',
      };
    } catch (error: any) {
      if (cached) {
        logger.debug(`Serving stale ${imageClass} entry after upstream error: ${error?.message}`);
        return { entry: cached, status: 'STALE' };
      }
      throw error;
    } finally {
      inflight.delete(lockKey);
    }
  })();

  inflight.set(lockKey, task);
  return task;
}

export interface InvalidateResult {
  removed: ImageClass[];
  freed_bytes: number;
}

export async function invalidate(key: string, imageClass?: ImageClass): Promise<InvalidateResult> {
  const targets = imageClass ? [imageClass] : IMAGE_CLASSES;
  const hash = hashKey(key);
  const removed: ImageClass[] = [];
  let freed = 0;

  for (const target of targets) {
    const known = index.has(indexKey(target, hash));
    let present = known;
    if (!present) {
      present = await fsp.access(entryPath(target, hash)).then(() => true).catch(() => false);
    }
    if (!present) continue;

    freed += await remove(target, hash);
    removed.push(target);
  }

  if (removed.length > 0) {
    logger.info(`Invalidated ${key} in ${removed.join(', ')}`);
  }
  return { removed, freed_bytes: freed };
}

export interface PurgeResult {
  success: boolean;
  message: string;
  freed_bytes: number;
  cleared: ImageClass[];
}

/** Purges one class subtree, or the whole cache when `imageClass` is omitted. */
export async function purge(imageClass?: ImageClass): Promise<PurgeResult> {
  const targets = imageClass ? [imageClass] : IMAGE_CLASSES;
  let freed = 0;

  for (const target of targets) {
    freed += totalsFor(target).bytes;
    await fsp.rm(path.join(getCacheDir(), target), { recursive: true, force: true }).catch((error: any) => {
      logger.warn(`Failed to purge ${target}: ${error?.message}`);
    });
    classTotals.set(target, { count: 0, bytes: 0 });
    const prefix = `${target}/`;
    for (const key of index.keys()) {
      if (key.startsWith(prefix)) index.delete(key);
    }
    memoryClear(prefix);
  }

  await fsp.mkdir(getCacheDir(), { recursive: true }).catch(() => { /* recreated lazily on put */ });

  const label = imageClass ? `${imageClass} images` : 'all cached images';
  logger.info(`Purged ${label} (${formatSize(freed)} freed)`);
  return {
    success: true,
    message: `Purged ${label}`,
    freed_bytes: freed,
    cleared: targets,
  };
}

export interface ClassStats {
  count: number;
  bytes: number;
  human: string;
}

export function stats(): Record<string, any> {
  const byType: Record<string, ClassStats> = {};
  for (const imageClass of IMAGE_CLASSES) {
    const totals = classTotals.get(imageClass);
    if (!totals || totals.count === 0) continue;
    byType[imageClass] = {
      count: totals.count,
      bytes: totals.bytes,
      human: formatSize(totals.bytes),
    };
  }

  const bytes = totalBytes();
  const budget = getMemoryBudget();
  return {
    cached_images: totalCount(),
    disk_usage: formatSize(bytes),
    disk_usage_bytes: bytes,
    max_size: getMaxSizeRaw(),
    ttl: getEntryTtlDays() > 0 ? `${getEntryTtlDays()}d` : 'never',
    inactive: `${getInactiveDays()}d`,
    by_type: byType,
    scanning,
    memory: {
      enabled: budget > 0,
      images: memory.size,
      usage: formatSize(memoryBytes),
      usage_bytes: memoryBytes,
      max_size: budget > 0 ? getMemorySizeRaw() : '0',
      hits: memoryHits,
    },
  };
}

function scheduleEviction(): void {
  if (evicting) return;
  if (totalBytes() <= getMaxBytes()) return;
  evicting = true;
  setImmediate(() => {
    evict()
      .catch((error: any) => logger.warn(`Eviction failed: ${error?.message}`))
      .finally(() => { evicting = false; });
  });
}

async function evict(): Promise<void> {
  const maxBytes = getMaxBytes();
  if (totalBytes() <= maxBytes) return;

  const target = Math.floor(maxBytes * 0.9);
  const candidates = [...index.values()].sort((a, b) => a.lastAccess - b.lastAccess);

  let removed = 0;
  let current = totalBytes();
  for (const candidate of candidates) {
    if (current <= target) break;
    current -= await remove(candidate.imageClass, candidate.hash);
    removed += 1;
  }

  if (removed > 0) {
    logger.info(`Evicted ${removed} entries, now at ${formatSize(totalBytes())} of ${getMaxSizeRaw()}`);
  }
}

/** Drops entries untouched for POSTER_CACHE_INACTIVE_DAYS (nginx `inactive=`). */
async function sweepInactive(): Promise<void> {
  const cutoff = Date.now() - getInactiveDays() * 24 * 60 * 60 * 1000;
  const stale = [...index.values()].filter((entry) => entry.lastAccess < cutoff);
  for (const entry of stale) {
    await remove(entry.imageClass, entry.hash);
  }
  if (stale.length > 0) {
    logger.info(`Swept ${stale.length} inactive entries`);
  }
}

/** Rebuilds the index from disk. Only stat() is needed — never a file read. */
async function scan(): Promise<void> {
  const root = getCacheDir();
  scanning = true;
  const started = Date.now();
  let found = 0;

  for (const imageClass of IMAGE_CLASSES) {
    const classDir = path.join(root, imageClass);
    let dir: fs.Dir;
    try {
      dir = await fsp.opendir(classDir, { recursive: true } as any);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        logger.warn(`Could not scan ${classDir}: ${error?.message}`);
      }
      continue;
    }

    for await (const dirent of dir) {
      if (!dirent.isFile()) continue;
      const name = dirent.name;
      if (name.endsWith('.tmp')) {
        // Interrupted write from a previous run.
        await fsp.unlink(path.join((dirent as any).parentPath || (dirent as any).path || classDir, name))
          .catch(() => { /* best effort */ });
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      try {
        const stat = await fsp.stat(entryPath(imageClass, name));
        addToIndex({
          imageClass,
          hash: name,
          size: stat.size,
          lastAccess: stat.mtimeMs,
        });
        found += 1;
      } catch {
        // Vanished between readdir and stat — nothing to index.
      }
    }
  }

  scanning = false;
  logger.info(`Indexed ${found} cached images (${formatSize(totalBytes())}) in ${Date.now() - started}ms`);
  scheduleEviction();
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await fsp.mkdir(getCacheDir(), { recursive: true }).catch((error: any) => {
    logger.warn(`Could not create cache dir: ${error?.message}`);
  });

  // Non-blocking: reads work against the filesystem, so startup need not wait.
  scan().catch((error: any) => logger.warn(`Initial scan failed: ${error?.message}`));

  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      sweepInactive().catch((error: any) => logger.warn(`Sweep failed: ${error?.message}`));
    }, 60 * 60 * 1000);
    sweepTimer.unref?.();
  }

  const budget = getMemoryBudget();
  logger.info(
    `Built-in poster cache active at ${getCacheDir()} ` +
    `(disk ${getMaxSizeRaw()}, memory ${budget > 0 ? getMemorySizeRaw() : 'disabled — disk only'}, ` +
    `ttl ${getEntryTtlDays() > 0 ? `${getEntryTtlDays()}d` : 'never expires'})`
  );
}

/** Test/import helper — lets the nginx importer populate totals without a rescan. */
export function isInitialized(): boolean {
  return initialized;
}
