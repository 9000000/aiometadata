/**
 * Redis Command Counter - Temporary diagnostic module
 * Wraps the Redis client to count all commands sent during startup.
 * 
 * Usage: import this module EARLY in server.ts to monkey-patch the redis client.
 */
import redis from './redisClient';
import consola from 'consola';

const logger = consola.withTag('Redis-Counter');

interface CommandLog {
  command: string;
  count: number;
  firstCaller?: string;
}

const commandCounts = new Map<string, CommandLog>();
let totalCommands = 0;
let isTracking = true;

// Commands we want to intercept
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
  // Skip Error, trackCommand, and the proxy wrapper lines
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('redisCounter') || line.includes('node_modules')) continue;
    // Extract just the filename and line number
    const match = line.match(/at\s+.*?\((.+?)\)/) || line.match(/at\s+(.+)/);
    if (match) {
      const fullPath = match[1];
      // Get just the last part of the path
      const parts = fullPath.replace(/\\/g, '/').split('/');
      const lastTwoParts = parts.slice(-2).join('/');
      return lastTwoParts;
    }
  }
  return 'unknown';
}

function trackCommand(command: string): void {
  if (!isTracking) return;
  totalCommands++;
  
  const caller = getCallerInfo();
  const existing = commandCounts.get(command);
  if (existing) {
    existing.count++;
  } else {
    commandCounts.set(command, { command, count: 1, firstCaller: caller });
  }
}

// Track pipeline commands too
function wrapPipeline(originalPipeline: any): any {
  return function(this: any, ...args: any[]) {
    trackCommand('pipeline');
    const pipeline = originalPipeline.apply(this, args);
    
    // Also wrap pipeline methods
    const pipelineProxy = new Proxy(pipeline, {
      get(target: any, prop: string) {
        const value = target[prop];
        if (typeof value === 'function' && TRACKED_COMMANDS.includes(prop)) {
          return function(...pArgs: any[]) {
            trackCommand(`pipeline:${prop}`);
            return value.apply(target, pArgs);
          };
        }
        return value;
      }
    });
    return pipelineProxy;
  };
}

export function installRedisCounter(): void {
  if (!redis) {
    logger.warn('No Redis client to instrument');
    return;
  }
  
  logger.info('🔍 Redis command counter INSTALLED — tracking all commands');
  
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
      (redis as any)[cmd] = function(...args: any[]) {
        trackCommand(cmd);
        return original.apply(redis, args);
      };
    }
  }
}

export function printRedisReport(): void {
  logger.info('');
  logger.info('═══════════════════════════════════════════════════════');
  logger.info(`  REDIS COMMAND REPORT — Total: ${totalCommands} commands`);
  logger.info('═══════════════════════════════════════════════════════');
  
  const sorted = Array.from(commandCounts.values()).sort((a, b) => b.count - a.count);
  for (const entry of sorted) {
    logger.info(`  ${entry.command.padEnd(20)} ${String(entry.count).padStart(8)} calls   (first: ${entry.firstCaller})`);
  }
  
  logger.info('═══════════════════════════════════════════════════════');
  logger.info('');
}

export function stopTracking(): void {
  isTracking = false;
}

export function getTotal(): number {
  return totalCommands;
}

export function getReport(): { total: number; commands: CommandLog[] } {
  return {
    total: totalCommands,
    commands: Array.from(commandCounts.values()).sort((a, b) => b.count - a.count),
  };
}

module.exports = { installRedisCounter, printRedisReport, stopTracking, getTotal, getReport };
