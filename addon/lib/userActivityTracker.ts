import consola from 'consola';
import database from './database';

const logger = consola.withTag('UserActivityTracker');

interface PendingUserStat {
  requests: number;
  lastActive: Date;
}

class UserActivityTracker {
  private pending: Map<string, PendingUserStat> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;

  constructor() {
    this.startPeriodicFlush(15_000); // Flush in-memory stats to DB every 15s
  }

  private isTrackingEnabled(): boolean {
    try {
      const { getSetting } = require('./settingsService.js');
      const val = getSetting('ENABLE_USER_REQUEST_TRACKING');
      if (val !== undefined && val !== '') {
        return val === 'true' || val === true;
      }
    } catch {}
    return process.env.ENABLE_USER_REQUEST_TRACKING !== 'false';
  }

  /**
   * Records a request made by userUUID. Increment is stored in-memory (0.0001ms, 0 DB/Redis load).
   */
  record(userUUID: string): void {
    if (!userUUID || typeof userUUID !== 'string' || !this.isTrackingEnabled()) return;

    const existing = this.pending.get(userUUID);
    if (existing) {
      existing.requests++;
      existing.lastActive = new Date();
    } else {
      this.pending.set(userUUID, { requests: 1, lastActive: new Date() });
    }
  }

  /**
   * Flushes all pending in-memory counts to the database in a single batch.
   */
  async flush(): Promise<void> {
    if (this.pending.size === 0 || this.isFlushing) return;
    this.isFlushing = true;

    const snapshot = Array.from(this.pending.entries());
    this.pending.clear();

    try {
      const batch = snapshot.map(([userUUID, stat]) => ({
        userUUID,
        requests: stat.requests,
        lastActive: stat.lastActive.toISOString(),
      }));
      await database.recordUserStatsBatch(batch);
    } catch (error: any) {
      logger.warn('Error flushing user activity stats:', error?.message);
      // Re-insert failed counts back to pending
      for (const [uuid, stat] of snapshot) {
        const cur = this.pending.get(uuid);
        if (cur) {
          cur.requests += stat.requests;
        } else {
          this.pending.set(uuid, stat);
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  startPeriodicFlush(intervalMs: number = 15_000): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => {});
    }, intervalMs);
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export const userActivityTracker = new UserActivityTracker();
module.exports = { userActivityTracker };
export default userActivityTracker;
