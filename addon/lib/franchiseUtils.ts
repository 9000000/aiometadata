import fs from 'fs';
import path from 'path';

// Define cache for loaded franchise lists
const franchiseCache: Record<string, any[]> = {};

/**
 * Loads a franchise JSON file from the static/franchises directory.
 * The files are expected to be arrays of objects with { id, title, type, poster, imdbId, ... }
 */
export function loadFranchiseList(id: string): any[] {
  const cacheKey = id; // e.g. "dc_moviesData"
  if (franchiseCache[cacheKey]) {
    return franchiseCache[cacheKey];
  }

  const filePath = path.join(process.cwd(), 'addon', 'static', 'franchises', `${id}.json`);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    const parsedData = JSON.parse(rawData);
    
    // Normalize to standard meta format
    const metas = parsedData.map((item: any) => {
      // Prioritize imdbId over string ID, or extract tt... from id if necessary.
      // E.g. { id: 'marvel_tt0077469', imdbId: 'tt0077469', title: 'Dr. Strange', poster: '...', type: 'movie' }
      let targetId = item.imdbId || item.id;
      
      // Some external IDs might just be raw numbers (TMDB), if so, prefix them.
      if (typeof targetId === 'number') {
        targetId = `tmdb:${targetId}`;
      } else if (item.tmdbId && !targetId.startsWith('tt')) {
         targetId = `tmdb:${item.tmdbId}`;
      }

      return {
        id: targetId,
        type: item.type === 'tv' ? 'series' : (item.type || 'movie'),
        name: item.title || item.name,
        poster: item.poster || null,
        description: item.overview || undefined,
        releaseInfo: item.releaseYear || item.release_date || undefined
      };
    });

    franchiseCache[cacheKey] = metas;
    return metas;
  } catch (err) {
    console.error(`Failed to load franchise data for ${id}:`, err);
    return [];
  }
}

/**
 * Gets a paginated list of metas for a franchise catalog.
 */
export function getFranchiseCatalog(id: string, page: number): any[] {
  // Strip the 'franchise.' prefix
  const listId = id.replace('franchise.', '');
  const metas = loadFranchiseList(listId);
  
  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
  const skip = (page - 1) * pageSize;
  
  return metas.slice(skip, skip + pageSize);
}
