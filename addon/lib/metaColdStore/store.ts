// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import consola from 'consola';
const { encodeCachePayload }: any = require('../cacheCodec');
const { getCacheEpoch }: any = require('../cacheEpoch');
import {
  getColdStorePath,
  getColdStoreMaxBytes,
  getColdTtlSeconds,
  getInactiveDays,
  getColdStoreStatsTtlSeconds,
  isColdStoreCompressionEnabled,
} from './config';

const logger = consola.withTag('ColdStore');

export type PutRow = {
  k: string;
  metaId: string;
  component: string;
  tier: 'frozen' | 'stable' | 'partial';
  componentData: any;
  encodedPayload?: Buffer | string;
};

let db: BetterSqlite3.Database | null = null;
const writeQueue: PutRow[] = [];
let flushScheduled = false;
let inFlightFlush: Promise<void> | null = null;
let bytesSinceEvictCheck = 0;
const EVICT_CHECK_MAX_BYTES = 64 * 1024 * 1024;

const TOUCH_FLUSH_INTERVAL_MS = 5_000;
const TOUCH_FLUSH_BATCH_THRESHOLD = 500;
const pendingTouches = new Map<string, number>();
let touchFlushTimer: NodeJS.Timeout | null = null;
let touchFlushScheduled = false;

let cachedTotalBytes = 0;
const cachedTierBytes = new Map<string, number>();

// Resolved once per open, not per query: the purge below is keyed to it, so a
// mid-run env change must not desync reads from what init() already dropped.
let currentEpoch = 0;

type UpsertDelta = { totalDelta: number; tierDeltas: Map<string, number> };

// Compiled once per open database; reads are keyed by how many keys they bind.
type HotStatements = {
  selectByCount: Map<number, BetterSqlite3.Statement>;
  touchMany: (entries: Array<[string, number]>) => void;
  upsertMany: (items: any[]) => UpsertDelta;
};
let hot: HotStatements | null = null;

function adjustTierBytes(tier: string, delta: number): void {
  const next = (cachedTierBytes.get(tier) || 0) + delta;
  if (next <= 0) cachedTierBytes.delete(tier);
  else cachedTierBytes.set(tier, next);
}

function applyRemovedRows(rows: Array<{ tier: string; n: number; k?: string }>): number {
  if (rows.length === 0) return 0;
  for (const r of rows) {
    if (r.k) pendingTouches.delete(r.k);
    cachedTotalBytes = Math.max(0, cachedTotalBytes - r.n);
    adjustTierBytes(r.tier, -r.n);
  }
  cachedStats = null;
  return rows.length;
}

function hotStatements(database: BetterSqlite3.Database): HotStatements {
  if (hot) return hot;
  const touch = database.prepare(`UPDATE meta_components SET last_access = ? WHERE k = ?`);
  const selectOld = database.prepare(`SELECT tier, LENGTH(payload) AS len FROM meta_components WHERE k = ?`);
  // `epoch` is part of the update set: a row left behind by a newer release is
  // reclaimed by whichever epoch last wrote it, so its payload and its label agree.
  const upsert = database.prepare(`
    INSERT INTO meta_components (k, meta_id, component, payload, tier, created_at, expires_at, last_access, epoch)
    VALUES (@k, @meta_id, @component, @payload, @tier, @created_at, @expires_at, @last_access, @epoch)
    ON CONFLICT(k) DO UPDATE SET
      payload = excluded.payload, tier = excluded.tier,
      expires_at = excluded.expires_at, last_access = excluded.last_access,
      epoch = excluded.epoch
  `);
  hot = {
    selectByCount: new Map(),
    touchMany: database.transaction((entries: Array<[string, number]>) => {
      for (const [k, ts] of entries) touch.run(ts, k);
    }),
    upsertMany: database.transaction((items: any[]) => {
      let totalDelta = 0;
      const tierDeltas = new Map<string, number>();
      for (const it of items) {
        const prev = selectOld.get(it.k) as { tier: string; len: number } | undefined;
        if (prev) {
          totalDelta -= prev.len;
          tierDeltas.set(prev.tier, (tierDeltas.get(prev.tier) || 0) - prev.len);
        }
        upsert.run(it);
        const len = it.payload.length;
        totalDelta += len;
        tierDeltas.set(it.tier, (tierDeltas.get(it.tier) || 0) + len);
      }
      return { totalDelta, tierDeltas };
    }),
  };
  return hot;
}

function flushTouches(): void {
  if (!db || pendingTouches.size === 0) return;
  const entries = Array.from(pendingTouches.entries());
  pendingTouches.clear();
  hotStatements(db).touchMany(entries);
}

function selectStatement(database: BetterSqlite3.Database, count: number): BetterSqlite3.Statement {
  const statements = hotStatements(database).selectByCount;
  let statement = statements.get(count);
  if (!statement) {
    const placeholders = Array.from({ length: count }, () => '?').join(',');
    statement = database.prepare(
      `SELECT k, payload, expires_at FROM meta_components WHERE k IN (${placeholders}) AND epoch = ?`
    );
    statements.set(count, statement);
  }
  return statement;
}

/**
 * Rows predating the epoch column carry the addon version inside `k` and have no
 * recorded payload shape. Epoch 0 marks them, and the purge in init() drops them.
 */
function ensureEpochColumn(database: BetterSqlite3.Database): void {
  const columns = database.prepare(`PRAGMA table_info(meta_components)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'epoch')) return;
  database.exec(`ALTER TABLE meta_components ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0`);
  logger.info('Migrated cold store schema: added epoch column');
}

export function init(): void {
  if (db) return;
  const file = getColdStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_components (
      k          TEXT PRIMARY KEY,
      meta_id    TEXT NOT NULL,
      component  TEXT NOT NULL,
      payload    BLOB NOT NULL,
      tier       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_access INTEGER NOT NULL,
      epoch      INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureEpochColumn(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mc_meta_id ON meta_components(meta_id);
    CREATE INDEX IF NOT EXISTS idx_mc_expires ON meta_components(expires_at);
    CREATE INDEX IF NOT EXISTS idx_mc_last_access ON meta_components(last_access);
    DROP INDEX IF EXISTS idx_mc_epoch;
    DROP INDEX IF EXISTS idx_mc_stats;
  `);

  currentEpoch = getCacheEpoch();
  // Only *older* epochs are dropped. Rows from a newer epoch are unreadable here
  // but are left alone, so rolling a release back and forward again is free.
  const dropped = db.prepare(`DELETE FROM meta_components WHERE epoch < ?`).run(currentEpoch).changes;
  if (dropped > 0) logger.info(`Dropped ${dropped} rows from epochs older than ${currentEpoch}`);

  cachedTotalBytes = 0;
  cachedTierBytes.clear();
  const tierRows = db.prepare(
    `SELECT tier, COALESCE(SUM(LENGTH(payload)), 0) AS bytes FROM meta_components GROUP BY tier`
  ).all() as Array<{ tier: string; bytes: number }>;
  for (const r of tierRows) {
    if (r.bytes > 0) {
      cachedTierBytes.set(r.tier, r.bytes);
      cachedTotalBytes += r.bytes;
    }
  }

  if (!touchFlushTimer) {
    touchFlushTimer = setInterval(() => {
      try {
        flushTouches();
      } catch (e: any) {
        logger.warn(`touch flush failed: ${e?.message}`);
      }
    }, TOUCH_FLUSH_INTERVAL_MS);
    touchFlushTimer.unref?.();
  }

  logger.info(`Meta cold store ready at ${file} (epoch ${currentEpoch})`);
}

export function getEncoded(keys: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!db || keys.length === 0) return out;
  const now = Date.now();
  const rows = selectStatement(db, keys.length)
    .all(...keys, currentEpoch) as Array<{ k: string; payload: Buffer; expires_at: number }>;

  for (const row of rows) {
    if (row.expires_at <= now) continue;
    out.set(row.k, row.payload);
    pendingTouches.set(row.k, now);
  }
  if (pendingTouches.size >= TOUCH_FLUSH_BATCH_THRESHOLD && !touchFlushScheduled) {
    touchFlushScheduled = true;
    setImmediate(() => {
      touchFlushScheduled = false;
      try {
        flushTouches();
      } catch (e: any) {
        logger.warn(`touch flush failed: ${e?.message}`);
      }
    });
  }
  return out;
}

export function put(rows: PutRow[]): void {
  if (!db || rows.length === 0) return;
  for (const r of rows) writeQueue.push(r);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => {
    flushScheduled = false;
    flushNow().catch((e: any) => logger.warn(`flush failed: ${e?.message}`));
  });
}

async function drainWriteQueue(): Promise<void> {
  while (db && writeQueue.length > 0) {
    const batch = writeQueue.splice(0, writeQueue.length);
    const now = Date.now();

    // Read once per flush, not per row, so a whole batch encodes consistently.
    const compressionEnabled = isColdStoreCompressionEnabled();

    const prepared: Array<{ k: string; meta_id: string; component: string; payload: Buffer; tier: string; created_at: number; expires_at: number; last_access: number; epoch: number }> = [];
    for (const r of batch) {
      if (!db) return;
      let payload: Buffer;
      if (r.encodedPayload !== undefined && r.encodedPayload !== null) {
        payload = Buffer.isBuffer(r.encodedPayload)
          ? r.encodedPayload
          : Buffer.from(String(r.encodedPayload), 'utf8');
      } else {
        const encoded = await encodeCachePayload(r.componentData, { compressionEnabled });
        payload = Buffer.isBuffer(encoded) ? encoded : Buffer.from(String(encoded), 'utf8');
      }
      prepared.push({
        k: r.k, meta_id: r.metaId, component: r.component, payload, tier: r.tier,
        created_at: now, expires_at: now + getColdTtlSeconds(r.tier) * 1000, last_access: now,
        epoch: currentEpoch,
      });
    }

    if (!db) return;
    for (const it of prepared) pendingTouches.delete(it.k);
    const { totalDelta, tierDeltas } = hotStatements(db).upsertMany(prepared);
    cachedTotalBytes = Math.max(0, cachedTotalBytes + totalDelta);
    for (const [tier, delta] of tierDeltas) {
      adjustTierBytes(tier, delta);
    }
    cachedStats = null;

    for (const it of prepared) bytesSinceEvictCheck += it.payload.length;
    if (bytesSinceEvictCheck >= Math.min(EVICT_CHECK_MAX_BYTES, Math.floor(getColdStoreMaxBytes() / 16))) {
      bytesSinceEvictCheck = 0;
      evictIfNeeded();
    }
  }
  flushTouches();
}

export function flushNow(): Promise<void> {
  if (!db) return Promise.resolve();
  if (inFlightFlush) {
    inFlightFlush = inFlightFlush.then(() => drainWriteQueue());
  } else {
    inFlightFlush = drainWriteQueue();
  }
  const current = inFlightFlush;
  current.finally(() => {
    if (inFlightFlush === current) inFlightFlush = null;
  }).catch(() => {});
  return current;
}

/**
 * Evicts whole titles. A title's rows are read and touched together, so the
 * titles owning the least recently used rows are the least recently used
 * titles; removing only rows would leave titles half-stored, which reads as a
 * miss and costs a full rebuild anyway.
 */
export function evictIfNeeded(batchRows: number = 500): void {
  if (!db) return;
  const max = getColdStoreMaxBytes();
  if (cachedTotalBytes <= max) return;
  flushTouches();
  const target = Math.floor(max * 0.9);
  const del = db.prepare(`DELETE FROM meta_components WHERE meta_id IN (
    SELECT DISTINCT meta_id FROM (SELECT meta_id FROM meta_components ORDER BY last_access ASC LIMIT ?)
  ) RETURNING k, tier, LENGTH(payload) AS n`);
  let guard = 0;
  while (cachedTotalBytes > target && guard++ < 10000) {
    const rows = del.all(batchRows) as Array<{ k: string; tier: string; n: number }>;
    if (rows.length === 0) break;
    applyRemovedRows(rows);
  }
  cachedStats = null;
}

function invalidated(changes: number): number {
  if (changes > 0) cachedStats = null;
  return changes;
}

export function invalidate(metaId: string): number {
  if (!db) return 0;
  const rows = db.prepare(
    `DELETE FROM meta_components WHERE meta_id = ? RETURNING k, tier, LENGTH(payload) AS n`
  ).all(metaId) as Array<{ k: string; tier: string; n: number }>;
  return applyRemovedRows(rows);
}

/** Drop a single row by its component key, as opposed to every row for a title. */
export function invalidateKey(k: string): number {
  if (!db) return 0;
  pendingTouches.delete(k);
  const rows = db.prepare(
    `DELETE FROM meta_components WHERE k = ? RETURNING tier, LENGTH(payload) AS n`
  ).all(k) as Array<{ tier: string; n: number }>;
  return applyRemovedRows(rows);
}

export function purge(): number {
  if (!db) return 0;
  pendingTouches.clear();
  const changes = db.prepare(`DELETE FROM meta_components`).run().changes;
  cachedTotalBytes = 0;
  cachedTierBytes.clear();
  return invalidated(changes);
}

/** Escape LIKE wildcards so an operator-supplied token matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function countByMetaId(metaId: string): number {
  if (!db || !metaId) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM meta_components WHERE meta_id = ?`
  ).get(metaId) as { c: number };
  return row.c;
}

export function countByToken(token: string): number {
  if (!db || !token) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM meta_components WHERE k LIKE ? ESCAPE '\\'`
  ).get(`%${escapeLike(token)}%`) as { c: number };
  return row.c;
}

export function invalidateByToken(token: string): number {
  if (!db || !token) return 0;
  const rows = db.prepare(
    `DELETE FROM meta_components WHERE k LIKE ? ESCAPE '\\' RETURNING k, tier, LENGTH(payload) AS n`
  ).all(`%${escapeLike(token)}%`) as Array<{ k: string; tier: string; n: number }>;
  return applyRemovedRows(rows);
}

export function sweep(): number {
  if (!db) return 0;
  flushTouches();
  const now = Date.now();
  const inactiveCutoff = now - getInactiveDays() * 86400 * 1000;
  const rows = db.prepare(
    `DELETE FROM meta_components WHERE expires_at <= ? OR last_access < ? RETURNING k, tier, LENGTH(payload) AS n`
  ).all(now, inactiveCutoff) as Array<{ k: string; tier: string; n: number }>;
  return applyRemovedRows(rows);
}

export type TierStats = { tier: string; count: number; titles: number; bytes: number };
export type ColdStoreStats = {
  enabled: boolean;
  rows: number;
  titles: number;
  bytes: number;
  maxBytes: number;
  tiers: TierStats[];
  oldestCreatedAt: number | null;
  nextExpiryAt: number | null;
  expiredRows: number;
};

let cachedStats: { at: number; value: ColdStoreStats } | null = null;

export function stats(): ColdStoreStats {
  const empty: ColdStoreStats = {
    enabled: false, rows: 0, titles: 0, bytes: 0, maxBytes: getColdStoreMaxBytes(),
    tiers: [], oldestCreatedAt: null, nextExpiryAt: null, expiredRows: 0,
  };
  if (!db) return empty;

  const ttlMs = getColdStoreStatsTtlSeconds() * 1000;
  if (cachedStats && ttlMs > 0 && Date.now() - cachedStats.at < ttlMs) return cachedStats.value;

  const now = Date.now();
  const r = db.prepare(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT meta_id) AS titles,
           MIN(created_at) AS oldest, MIN(expires_at) AS next_expiry,
           COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired
    FROM meta_components
  `).get(now) as { rows: number; titles: number; oldest: number | null; next_expiry: number | null; expired: number };

  const rawTiers = db.prepare(`
    SELECT tier, COUNT(*) AS count, COUNT(DISTINCT meta_id) AS titles
    FROM meta_components GROUP BY tier ORDER BY tier
  `).all() as Array<{ tier: string; count: number; titles: number }>;

  const tiers: TierStats[] = rawTiers.map((t) => ({
    tier: t.tier,
    count: t.count,
    titles: t.titles,
    bytes: cachedTierBytes.get(t.tier) || 0,
  }));

  const value: ColdStoreStats = {
    enabled: true,
    rows: r.rows,
    titles: r.titles,
    bytes: cachedTotalBytes,
    maxBytes: getColdStoreMaxBytes(),
    tiers,
    oldestCreatedAt: r.oldest ?? null,
    nextExpiryAt: r.next_expiry ?? null,
    expiredRows: r.expired,
  };
  cachedStats = { at: Date.now(), value };
  return value;
}

export function close(): void {
  if (touchFlushTimer) {
    clearInterval(touchFlushTimer);
    touchFlushTimer = null;
  }
  if (db) {
    try {
      flushTouches();
    } catch (e: any) {
      logger.warn(`touch flush on close failed: ${e?.message}`);
    }
    db.close();
    db = null;
    hot = null;
  }
  pendingTouches.clear();
  writeQueue.length = 0;
  inFlightFlush = null;
  flushScheduled = false;
  touchFlushScheduled = false;
  bytesSinceEvictCheck = 0;
  cachedTotalBytes = 0;
  cachedTierBytes.clear();
  cachedStats = null;
}

module.exports = {
  init, getEncoded, put, flushNow, invalidate, invalidateKey, invalidateByToken,
  countByToken, countByMetaId, purge, sweep, stats, close, evictIfNeeded,
};
