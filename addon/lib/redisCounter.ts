/**
 * Redis Command Counter & Tracer
 * Wraps the Redis client to track, log, and count all commands sent (especially background ones).
 */
import redis from './redisClient.js';
import consola from 'consola';

const logger = consola.withTag('Redis-Counter');

interface CommandLog {
  command: string;
  count: number;
  firstCaller?: string;
  lastCaller?: string;
  sampleKeys: Set<string>;
}

const commandCounts = new Map<string, CommandLog>();
const callerCounts = new Map<string, number>();
let totalCommands = 0;
let isTracking = true;
let reportingInterval: NodeJS.Timeout | null = null;

// Commands to intercept
const TRACKED_COMMANDS = [
  'get', 'set', 'del', 'mget', 'mset', 'setex', 'getBuffer',
  'scan', 'keys', 'dbsize', 'ttl', 'pttl', 'expire',
  'hget', 'hset', 'hgetall', 'hdel', 'hmget', 'hmset',
  'lrange', 'lpush', 'rpush', 'llen',
  'sadd', 'smembers', 'scard', 'srem',
  'zadd', 'zrange', 'zrevrange', 'zrangebyscore', 'zremrangebyscore', 'zcard', 'zscore',
  'pipeline', 'multi',
  'exists', 'type', 'info', 'ping',
];

function getCallerInfo(): string {
  const stack = new Error().stack || '';
  const lines = stack.split('\n');
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('redisCounter') || line.includes('node_modules') || line.includes('node:internal')) continue;
    const match = line.match(/at\s+.*?\((.+?)\)/) || line.match(/at\s+(.+)/);
    if (match) {
      const fullPath = match[1];
      const parts = fullPath.replace(/\\/g, '/').split('/');
      return parts.slice(-2).join('/');
    }
  }
  return 'unknown';
}

function extractKey(cmd: string, args: any[]): string {
  if (!args || args.length === 0) return '';
  const first = args[0];
  if (typeof first === 'string') return first;
  if (Buffer.isBuffer(first)) return first.toString('utf8');
  if (Array.isArray(first)) return first.slice(0, 3).join(',');
  return String(first);
}

function trackCommand(command: string, args: any[] = []): void {
  if (!isTracking) return;
  totalCommands++;

  const caller = getCallerInfo();
  const key = extractKey(command, args);

  // Real-time trace logging (enabled by default, can be silenced via SILENT_REDIS_TRACE=true)
  const isRealtimeLogEnabled = process.env.SILENT_REDIS_TRACE !== 'true';
  if (isRealtimeLogEnabled) {
    const keyPreview = key ? (key.length > 80 ? key.substring(0, 77) + '...' : key) : '<no-key>';
    logger.info(`[CMD] ${command.toUpperCase().padEnd(8)} ${keyPreview} (caller: ${caller})`);
  }

  // Update command stats
  const existing = commandCounts.get(command);
  if (existing) {
    existing.count++;
    existing.lastCaller = caller;
    if (key && existing.sampleKeys.size < 5) {
      existing.sampleKeys.add(key.length > 50 ? key.substring(0, 47) + '...' : key);
    }
  } else {
    const sampleKeys = new Set<string>();
    if (key) sampleKeys.add(key.length > 50 ? key.substring(0, 47) + '...' : key);
    commandCounts.set(command, { command, count: 1, firstCaller: caller, lastCaller: caller, sampleKeys });
  }

  // Update caller stats
  const currentCallerCount = callerCounts.get(caller) || 0;
  callerCounts.set(caller, currentCallerCount + 1);
}

function wrapPipeline(originalPipeline: any): any {
  return function (this: any, ...args: any[]) {
    trackCommand('pipeline', args);
    const pipeline = originalPipeline.apply(this, args);

    const pipelineProxy = new Proxy(pipeline, {
      get(target: any, prop: string) {
        const value = target[prop];
        if (typeof value === 'function' && TRACKED_COMMANDS.includes(prop)) {
          return function (...pArgs: any[]) {
            trackCommand(`pipeline:${prop}`, pArgs);
            return value.apply(target, pArgs);
          };
        }
        return value;
      },
    });
    return pipelineProxy;
  };
}

export function installRedisCounter(): void {
  if (!redis) {
    logger.warn('No Redis client to instrument');
    return;
  }

  logger.info('🔍 Redis command counter & tracer INSTALLED — tracking all commands');

  for (const cmd of TRACKED_COMMANDS) {
    if (cmd === 'pipeline' || cmd === 'multi') {
      const original = (redis as any)[cmd];
      if (typeof original === 'function') {
        (redis as any)[cmd] = wrapPipeline(original);
      }
      continue;
    }

    const original = (redis as any)[cmd];
    if (typeof original === 'function') {
      (redis as any)[cmd] = function (...args: any[]) {
        trackCommand(cmd, args);
        return original.apply(redis, args);
      };
    }
  }
}

export function printRedisReport(): void {
  logger.info('');
  logger.info('════════════════════════════════════════════════════════════════════════════════');
  logger.info(`  REDIS COMMAND REPORT — Total: ${totalCommands} commands`);
  logger.info('────────────────────────────────────────────────────────────────────────────────');
  logger.info('  Commands breakdown:');
  const sortedCmds = Array.from(commandCounts.values()).sort((a, b) => b.count - a.count);
  for (const entry of sortedCmds) {
    const keysSample = Array.from(entry.sampleKeys || []).slice(0, 2).join(' | ');
    logger.info(`    ${entry.command.padEnd(16)} ${String(entry.count).padStart(6)} calls | samples: [${keysSample}]`);
  }
  logger.info('────────────────────────────────────────────────────────────────────────────────');
  logger.info('  Top Callers (Background / Request sources):');
  const sortedCallers = Array.from(callerCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [caller, count] of sortedCallers) {
    logger.info(`    ${caller.padEnd(45)} ${String(count).padStart(6)} calls`);
  }
  logger.info('════════════════════════════════════════════════════════════════════════════════');
  logger.info('');
}

export function startPeriodicReporting(intervalMs: number = 60_000): void {
  if (reportingInterval) clearInterval(reportingInterval);
  reportingInterval = setInterval(() => {
    printRedisReport();
  }, intervalMs);
  if (reportingInterval.unref) {
    reportingInterval.unref();
  }
}

export function stopTracking(): void {
  isTracking = false;
  if (reportingInterval) {
    clearInterval(reportingInterval);
    reportingInterval = null;
  }
}

export function getTotal(): number {
  return totalCommands;
}

export function getReport(): { total: number; commands: CommandLog[]; callers: Record<string, number> } {
  return {
    total: totalCommands,
    commands: Array.from(commandCounts.values()).sort((a, b) => b.count - a.count),
    callers: Object.fromEntries(callerCounts),
  };
}

module.exports = {
  installRedisCounter,
  printRedisReport,
  startPeriodicReporting,
  stopTracking,
  getTotal,
  getReport,
};
