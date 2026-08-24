import fs from 'fs';
import path from 'path';
import consola from 'consola';

const logger = consola.withTag('FranchiseCollections');

// In-Memory cache for franchise lists
const franchiseCache: Record<string, any[]> = {};

const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com/9000000/aiometadata/tet/addon/static/franchises';

function normalizeFranchiseItems(parsedData: any[]): any[] {
  return parsedData.map((item: any) => {
    let targetId = item.imdbId || item.id;
    
    // Prefix raw numbers with tmdb:
    if (typeof targetId === 'number') {
      targetId = `tmdb:${targetId}`;
    } else if (item.tmdbId && !targetId.startsWith('tt')) {
      targetId = `tmdb:${item.tmdbId}`;
    }

    let poster = item.poster || null;
    if (poster && typeof poster === 'string' && poster.includes('image.tmdb.org/t/p/')) {
      poster = poster.replace(/\/t\/p\/(?:w500|w600_and_h900_bestv2|original)\//, '/t/p/w342/');
    }

    return {
      id: targetId,
      type: item.type === 'tv' ? 'series' : (item.type || 'movie'),
      name: item.title || item.name,
      poster: poster,
      description: item.overview || undefined,
      releaseInfo: item.releaseYear || item.release_date || undefined
    };
  });
}

/**
 * Loads a franchise JSON file from memory cache or local static directory.
 */
export function loadFranchiseList(id: string): any[] {
  const cacheKey = id; // e.g. "dc_moviesData"
  if (franchiseCache[cacheKey] && franchiseCache[cacheKey].length > 0) {
    return franchiseCache[cacheKey];
  }

  const filePath = path.join(process.cwd(), 'addon', 'static', 'franchises', `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    const parsedData = JSON.parse(rawData);
    const metas = normalizeFranchiseItems(parsedData);

    franchiseCache[cacheKey] = metas;
    return metas;
  } catch (err: any) {
    logger.error(`Failed to load local franchise data for ${id}:`, err.message);
    return [];
  }
}

/**
 * Gets a paginated list of metas for a franchise catalog.
 */
export function getFranchiseCatalog(id: string, page: number): any[] {
  const listId = id.replace('franchise.', '');
  const metas = loadFranchiseList(listId);
  
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string, 10) || 20;
  const skip = (page - 1) * pageSize;
  
  return metas.slice(skip, skip + pageSize);
}

/**
 * Background auto-sync function to update franchise data directly from GitHub into memory cache.
 */
export async function syncFranchiseFromRemote(id: string): Promise<boolean> {
  const cleanId = id.replace('franchise.', '');
  const remoteUrl = `${RAW_GITHUB_BASE}/${cleanId}.json`;

  try {
    const response = await fetch(remoteUrl, {
      headers: {
        'User-Agent': 'AIOMetadata-Koyeb-Runtime',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return false;
    }

    const parsed = await response.json();
    if (Array.isArray(parsed) && parsed.length > 0) {
      const metas = normalizeFranchiseItems(parsed);
      franchiseCache[cleanId] = metas;
      logger.debug(`[Auto-Sync] Updated ${cleanId} from GitHub (${metas.length} items)`);
      return true;
    }
  } catch (err: any) {
    logger.debug(`[Auto-Sync] Could not fetch remote ${cleanId}: ${err.message}`);
  }

  return false;
}

/**
 * Initialize automatic periodic sync (runs every 24 hours).
 */
export function initFranchiseAutoSync(): void {
  const syncAll = async () => {
    logger.info('Running periodic background sync for Franchise Collections...');
    const franchisesDir = path.join(process.cwd(), 'addon', 'static', 'franchises');
    if (fs.existsSync(franchisesDir)) {
      const files = fs.readdirSync(franchisesDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const id = file.replace('.json', '');
        await syncFranchiseFromRemote(id);
      }
    }
  };

  // Run initial background sync 30s after startup
  setTimeout(() => {
    syncAll().catch(err => logger.error('Initial franchise sync error:', err));
  }, 30000);

  // Repeat every 24 hours
  setInterval(() => {
    syncAll().catch(err => logger.error('Periodic franchise sync error:', err));
  }, 24 * 60 * 60 * 1000);
}
