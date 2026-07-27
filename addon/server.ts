// Initialize global HTTP proxy before any other imports that use undici
import './utils/httpClient.js';

import * as express from 'express';
import { startServerWithCacheWarming } from './index.js';
import { initializeMapper } from './lib/id-mapper.js';
import { initializeAnimeListMapper } from './lib/anime-list-mapper.js';
import { initializeMappings } from './lib/wiki-mapper.js';
import { initializeRatings } from './lib/imdbRatings.js';
import { initializeTmdbNetworkIndex } from './lib/tmdb-network-index.js';
import { initializeTmdbKeywordIndex } from './lib/tmdb-keyword-index.js';
import { runCacheCleanup } from './cache-cleanup.js';
import { runCachePathMigration } from './lib/cache-path-migration.js';
import { performEpochCleanup } from './lib/epochCleanup.js';
import { waitForRedisReady } from './lib/redisReady.js';
import database from './lib/database.js';
import consola from 'consola';
import { installLogReporter } from './lib/logBuffer.js';
import { initializeSettings } from './lib/settingsService.js';
import { getPosterProxyPrefix, isBuiltinPosterCacheEnabled } from './lib/posterCache/config.js';
import { runNginxImport } from './lib/posterCache/nginxImport.js';
import * as posterCacheStore from './lib/posterCache/store.js';
import * as imageWarmQueue from './lib/posterCache/warmQueue.js';

installLogReporter();

const PORT: number = parseInt(process.env.PORT || '3232', 10);
 
async function startServer(): Promise<void> {
  consola.info('--- Addon Starting Up ---');
 
  process.on('uncaughtException', (error: Error) => {
    consola.error('--- UNCAUGHT EXCEPTION ---');
    consola.error('Error:', error.message);
    consola.error('Stack:', error.stack);
    consola.error('This error was not caught and could crash the application.');
  });
  
  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    consola.error('--- UNHANDLED PROMISE REJECTION ---');
    consola.error('Reason:', reason);
    consola.error('Promise:', promise);
    consola.error('This rejection was not handled and could crash the application.');
  });
 
  // Database must initialize first
  consola.info('Initializing Database...');
  await database.initialize();
  consola.success('Database initialization complete.');

  await initializeSettings();

  // After initializeSettings(), so a cache enabled from the dashboard (stored in
  // the DB rather than the environment) is picked up on the next start.
  if (isBuiltinPosterCacheEnabled()) {
    await posterCacheStore.init();
    await imageWarmQueue.loadSummary();
    if (!getPosterProxyPrefix()) {
      consola.warn(
        '[PosterCache] Enabled, but no public URL could be derived: set HOST_NAME (or POSTER_PROXY_PREFIX_URL). ' +
        'Images will be served directly from upstream and nothing will be cached.'
      );
    }
    // Background: importing a large nginx cache must not delay serving.
    runNginxImport().catch((e: any) => consola.warn('[PosterCache] nginx import failed:', e?.message));
  }

  const metaColdStore = require('./lib/metaColdStore');
  if (metaColdStore.isEnabled()) {
    metaColdStore.init();
    setInterval(() => {
      try { metaColdStore.sweep(); } catch (e: any) { consola.warn('[ColdStore] sweep failed:', e?.message); }
    }, 60 * 60 * 1000).unref?.();
  }

  const redisReady = await waitForRedisReady();
  if (redisReady) {
    consola.success('Redis ready.');
  } else {
    consola.info('Redis caching disabled.');
  }
  
  // Cache path migration
  consola.info('Running cache path migration...');
  await runCachePathMigration();
  consola.success('Cache path migration complete.');
  
  consola.info('Initializing Mappers, Ratings, and Cache Cleanup...');

  performEpochCleanup().catch((error: any) => {
    consola.error('Background epoch cleanup failed:', error.message);
  });
  
  const initializationTasks = [
    {
      name: 'ID Mapper (anime-list.json)',
      task: async () => {
        consola.info('Initializing ID Mapper...');
        await initializeMapper();
      },
      critical: true
    },
    {
      name: 'Anime List Mapper (anime-list.xml)',
      task: async () => {
        consola.info('Initializing Anime List Mapper...');
        await initializeAnimeListMapper();
      },
      critical: true
    },
    {
      name: 'Wiki Mappings',
      task: async () => {
        consola.info('Initializing Wiki Mappings...');
        await initializeMappings();
      },
      critical: true
    },
    {
      name: 'IMDb Ratings',
      task: async () => {
        consola.info('Initializing IMDb Ratings...');
        await initializeRatings();
      },
      critical: true
    },
    {
      name: 'TMDB Network Index',
      task: async () => {
        consola.info('Initializing TMDB Network Index...');
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TMDB Network Index init timed out after 30s — will retry on first use')), 30000)
        );
        await Promise.race([initializeTmdbNetworkIndex(), timeout]);
      },
      critical: false
    },
    {
      name: 'TMDB Keyword Index',
      task: async () => {
        consola.info('Initializing TMDB Keyword Index...');
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('TMDB Keyword Index init timed out after 30s — will retry on first use')), 30000)
        );
        await Promise.race([initializeTmdbKeywordIndex(), timeout]);
      },
      critical: false
    },
    {
      name: 'Cache Cleanup Check',
      task: async () => {
        consola.info('Checking for one-time cache cleanup...');
        await runCacheCleanup();
      },
      critical: false
    },
    {
      name: 'FlixPatrol Availability Index',
      task: async () => {
        consola.info('Initializing FlixPatrol Availability Index...');
        const { initializeFlixPatrolAvailability } = require('./utils/flixpatrolUtils.js');
        await initializeFlixPatrolAvailability();
      },
      critical: false
    }
  ];
  
  // Execute all tasks in parallel
  const results = await Promise.allSettled(
    initializationTasks.map(({ task }) => task())
  );
  
  // Check results and log appropriately
  const failures: string[] = [];
  results.forEach((result, index) => {
    const { name, critical } = initializationTasks[index];
    if (result.status === 'fulfilled') {
      consola.success(`${name} initialization complete.`);
    } else {
      consola.error(`${name} failed to initialize:`, result.reason);
      if (critical) {
        failures.push(name);
      }
    }
  });
  
  // Abort startup if any critical tasks failed
  if (failures.length > 0) {
    throw new Error(`Critical initialization failures: ${failures.join(', ')}`);
  }
  
  consola.success('All initializations complete.');
  
  // PHASE 3: Start server with cache warming
  consola.info('Starting server with cache warming...');
  const addon: any = await startServerWithCacheWarming();
  
  // PHASE 4: Start background catalog warming (after server initialization)
  const { startMALWarmup } = require('./lib/malCatalogWarmer.js');
  startMALWarmup();
  
  const { startComprehensiveCatalogWarming } = require('./lib/comprehensiveCatalogWarmer.js');
  startComprehensiveCatalogWarming();
  
  // PHASE 5: Start cache cleanup scheduler
  consola.info('Starting cache cleanup scheduler...');
  const { startCacheCleanupScheduler } = require('./lib/cacheCleanupScheduler.js');
  
  const indexModule = require('./index.js');
  const dashboardApi = indexModule.getDashboardAPI();
  startCacheCleanupScheduler(dashboardApi);
  
  const server = addon.listen(PORT, () => {
    consola.success(`Addon active and listening on port ${PORT}.`);
    consola.info(`Open http://127.0.0.1:${PORT} in your browser.`);
  });

  const shutdown = () => {
    consola.info('Received shutdown signal, closing server...');
    server.close(() => {
      consola.success('Server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      consola.warn('Forceful shutdown after timeout.');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
 
startServer().catch((error: Error) => {
  consola.error('--- FATAL STARTUP ERROR ---');
  consola.error(error);
  process.exit(1);
});
