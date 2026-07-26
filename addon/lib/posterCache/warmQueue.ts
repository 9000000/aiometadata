import consola from 'consola';
import {
  formatSize,
  getWarmConcurrencyMax,
  getWarmConcurrencyMin,
  getWarmQueueMax,
  getWarmTargetLagMs,
  isWarmQueueEnabled,
  type ImageClass,
} from './config.js';
import * as store from './store.js';
import { fetchImage } from './upstream.js';

const logger = consola.withTag('ImageWarm');

export interface WarmTarget {
  imageClass: ImageClass;
  url: string;
  http?: string;
  checkClass?: ImageClass;
  checkKey?: string;
}

interface Stats {
  offered: number;
  skipped: number;
  queued: number;
  warmed: number;
  alreadyFresh: number;
  rendered: number;
  failed: number;
  dropped: number;
  atCapacity: number;
}

const queue: WarmTarget[] = [];
const pending = new Set<string>();
let head = 0;

let active = 0;
let desired = 0;
let draining = false;
let lagTimer: NodeJS.Timeout | null = null;
let lastTick = 0;
let observedLag = 0;
let capacityWarned = false;
let idleTimer: NodeJS.Timeout | null = null;

const stats: Stats = {
  offered: 0, skipped: 0, queued: 0, warmed: 0, alreadyFresh: 0, rendered: 0,
  failed: 0, dropped: 0, atCapacity: 0,
};

const LAG_INTERVAL_MS = 250;

function depth(): number {
  return queue.length - head;
}

function compact(): void {
  if (head > 4096 && head * 2 >= queue.length) {
    queue.splice(0, head);
    head = 0;
  }
}

function startLagProbe(): void {
  if (lagTimer) return;
  lastTick = Date.now();
  desired = getWarmConcurrencyMin();
  lagTimer = setInterval(() => {
    const now = Date.now();
    observedLag = Math.max(0, now - lastTick - LAG_INTERVAL_MS);
    lastTick = now;

    const target = getWarmTargetLagMs();
    const min = getWarmConcurrencyMin();
    const max = getWarmConcurrencyMax();

    if (observedLag > target * 2) {
      desired = Math.max(min, Math.floor(desired / 2));
    } else if (observedLag > target) {
      desired = Math.max(min, desired - 1);
    } else if (observedLag < target / 2) {
      desired = Math.min(max, desired + Math.max(1, Math.floor(desired / 4)));
    }
    pump();
  }, LAG_INTERVAL_MS);
  lagTimer.unref?.();
}

function stopLagProbe(): void {
  if (!lagTimer) return;
  clearInterval(lagTimer);
  lagTimer = null;
}

const IDLE_SETTLE_MS = 15000;

function scheduleIdleReport(): void {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (depth() > 0 || active > 0) return;
    draining = false;
    stopLagProbe();
    logger.info(
      `Image warming idle — ${stats.warmed} fetched, ${stats.skipped} skipped, ` +
      `${stats.alreadyFresh} already fresh, ${stats.rendered} rendered, ` +
      `${stats.failed} failed, ${stats.dropped} dropped, ${stats.atCapacity} over capacity`
    );
  }, IDLE_SETTLE_MS);
  idleTimer.unref?.();
}

function cancelIdleReport(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function keyOf(target: WarmTarget): string {
  return target.http ? `h:${target.http}` : `${target.imageClass}:${target.url}`;
}

export function offer(targets: WarmTarget[]): void {
  if (!isWarmQueueEnabled() || targets.length === 0) return;

  const max = getWarmQueueMax();
  const capacity = store.capacityUsed();
  const full = capacity.max > 0 && capacity.ratio >= 0.98;

  if (full && !capacityWarned) {
    capacityWarned = true;
    logger.warn(
      `Image cache is at ${(capacity.ratio * 100).toFixed(0)}% of its ${formatSize(capacity.max)} budget. ` +
      `Warming new images would evict images it just warmed, so they are being skipped. ` +
      `Raise POSTER_CACHE_MAX_SIZE or disable image classes you do not need.`
    );
  }

  for (const target of targets) {
    stats.offered += 1;

    const freshClass = target.http ? target.checkClass : target.imageClass;
    const freshKey = target.http ? target.checkKey : target.url;
    if (freshClass && freshKey && store.isCachedFresh(freshClass, freshKey)) {
      stats.skipped += 1;
      continue;
    }
    if (full) {
      stats.atCapacity += 1;
      continue;
    }
    if (depth() >= max) {
      stats.dropped += 1;
      continue;
    }

    const key = keyOf(target);
    if (pending.has(key)) continue;
    pending.add(key);
    queue.push(target);
    stats.queued += 1;
  }

  if (depth() > 0) {
    cancelIdleReport();
    startLagProbe();
    pump();
  }
}

async function runOne(target: WarmTarget): Promise<void> {
  if (target.http) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(target.http, { method: 'GET', signal: controller.signal });
      await response.arrayBuffer();
      stats.rendered += 1;
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  const result = await store.getOrFetch(target.imageClass, target.url, (validators) => fetchImage(target.url, { validators }));
  if (result.status === 'HIT') stats.alreadyFresh += 1;
  else stats.warmed += 1;
}

function pump(): void {
  const max = getWarmConcurrencyMax();
  const limit = Math.min(Math.max(desired, getWarmConcurrencyMin()), max);

  while (active < limit && depth() > 0) {
    const target = queue[head];
    head += 1;
    compact();
    active += 1;
    draining = true;

    runOne(target)
      .catch(() => { stats.failed += 1; })
      .finally(() => {
        pending.delete(keyOf(target));
        active -= 1;
        if (depth() > 0) {
          pump();
        } else if (active === 0 && draining) {
          scheduleIdleReport();
        }
      });
  }
}

export function getStats(): Stats & { depth: number; concurrency: number; lagMs: number } {
  return { ...stats, depth: depth(), concurrency: active, lagMs: observedLag };
}

export function reset(): void {
  queue.length = 0;
  head = 0;
  pending.clear();
  capacityWarned = false;
  for (const key of Object.keys(stats) as (keyof Stats)[]) stats[key] = 0;
}

export async function drain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((depth() > 0 || active > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return depth() === 0 && active === 0;
}
