import axios from 'axios';
import { UserConfig } from '../types/index.js';
import { cacheWrap, cacheWrapGlobal, cacheWrapMetaSmart } from './getCache.js';
import { getMeta } from './getMeta.js';
import { searchMovie, searchTv, movieExternalIds, tvExternalIds } from './getTmdb.js';
import consola from 'consola';
import nameToImdb from 'name-to-imdb';

const logger = consola.withTag('RottenTomatoes');

const RT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const RT_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Anime',
  'Biography',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Fantasy',
  'Horror',
  'Kids & Family',
  'Mystery & Thriller',
  'Romance',
  'Sci-Fi',
  'War',
  'Western',
];

export const RT_GENRE_MAP: Record<string, string> = {
  'action': 'action',
  'adventure': 'adventure',
  'animation': 'animation',
  'anime': 'anime',
  'biography': 'biography',
  'comedy': 'comedy',
  'crime': 'crime',
  'documentary': 'documentary',
  'drama': 'drama',
  'fantasy': 'fantasy',
  'horror': 'horror',
  'kids & family': 'kids_and_family',
  'kids and family': 'kids_and_family',
  'kids_and_family': 'kids_and_family',
  'mystery & thriller': 'mystery_and_thriller',
  'mystery and thriller': 'mystery_and_thriller',
  'mystery_and_thriller': 'mystery_and_thriller',
  'romance': 'romance',
  'sci-fi': 'sci_fi',
  'sci_fi': 'sci_fi',
  'war': 'war',
  'western': 'western',
};

export function normalizeRtGenre(genreName: string | undefined): string | null {
  if (!genreName || genreName.toLowerCase() === 'none' || genreName.toLowerCase() === 'all') {
    return null;
  }
  const clean = genreName.trim().toLowerCase();
  return RT_GENRE_MAP[clean] || clean.replace(/ & /g, '_and_').replace(/[ -]/g, '_').replace(/\+/g, '');
}

export function getRtListEndpoint(catalogId: string, type: string): string {
  const cleanId = catalogId.replace(/^rt\./, '').replace(/_(movie|series|anime|all)$/, '');

  if (type === 'movie') {
    if (cleanId === 'in_theaters') {
      return 'movies_in_theaters/sort:popular';
    }
    if (cleanId === 'verified_hot') {
      return 'movies_at_home/audience:verified_hot~sort:popular';
    }
    if (cleanId === 'popular') {
      return 'movies_at_home/sort:popular';
    }
    // Default certified fresh
    return 'movies_at_home/critics:certified_fresh';
  } else {
    // Series / TV Shows
    if (cleanId === 'verified_hot') {
      return 'tv_series_browse/audience:verified_hot~sort:popular';
    }
    if (cleanId === 'popular') {
      return 'tv_series_browse/sort:popular';
    }
    // Default fresh
    return 'tv_series_browse/critics:fresh~sort:popular';
  }
}

/**
 * Extract 4-digit release year from RT item metadata
 */
function extractYear(item: any): number | undefined {
  if (item?.releaseDateText) {
    const match = String(item.releaseDateText).match(/\b(19\d\d|20\d\d)\b/);
    if (match) return parseInt(match[1], 10);
  }
  if (item?.mediaUrl) {
    const match = String(item.mediaUrl).match(/_(\d{4})$/);
    if (match) return parseInt(match[1], 10);
  }
  return undefined;
}

function resolveNameToImdb(title: string, year?: number, type?: string): Promise<string | null> {
  return new Promise((resolve) => {
    nameToImdb({ name: title, ...(year ? { year } : {}), ...(type ? { type } : {}) }, (err: any, res: string) => {
      if (err || !res) {
        resolve(null);
      } else {
        resolve(res);
      }
    });
  });
}

/**
 * Resolve Rotten Tomatoes item to TMDB and IMDb IDs
 */
async function resolveRtItemToIds(item: any, type: string, config: UserConfig): Promise<{ tmdbId?: number; imdbId?: string } | null> {
  const emsId = item?.emsId || item?.title;
  if (!emsId) return null;

  const cacheKey = `rt:resolve:${type}:${emsId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    const title = item?.title?.trim();
    if (!title) return null;

    const year = extractYear(item);
    const tmdbType = type === 'movie' ? 'movie' : 'series';

    // 1. Try TMDB search first
    try {
      let tmdbResult: any;
      if (tmdbType === 'movie') {
        const searchParams: any = { query: title, include_adult: false };
        if (year) searchParams.year = year;
        tmdbResult = await searchMovie(searchParams, config);
      } else {
        const searchParams: any = { query: title, include_adult: false };
        if (year) searchParams.first_air_date_year = year;
        tmdbResult = await searchTv(searchParams, config);
      }

      let tmdbItem = tmdbResult?.results?.[0];
      if (!tmdbItem && year) {
        // Retry search without year filter if no exact match found
        if (tmdbType === 'movie') {
          tmdbResult = await searchMovie({ query: title, include_adult: false }, config);
        } else {
          tmdbResult = await searchTv({ query: title, include_adult: false }, config);
        }
        tmdbItem = tmdbResult?.results?.[0];
      }

      if (tmdbItem?.id) {
        const tmdbId = tmdbItem.id;
        let imdbId: string | undefined;

        if (tmdbType === 'movie') {
          const externalIds = await movieExternalIds(String(tmdbId), config);
          imdbId = externalIds?.imdb_id;
        } else {
          const externalIds = await tvExternalIds(String(tmdbId), config);
          imdbId = externalIds?.imdb_id;
        }

        return { tmdbId, imdbId };
      }
    } catch (err: any) {
      logger.debug(`TMDB search failed for RT item "${title}": ${err.message}`);
    }

    // 2. Fallback to nameToImdb
    try {
      const imdbId = await resolveNameToImdb(title, year, tmdbType);
      if (imdbId) {
        return { imdbId };
      }
    } catch (err: any) {
      logger.debug(`nameToImdb failed for RT item "${title}": ${err.message}`);
    }

    logger.debug(`No match found for RT item: "${title}" (${year || 'unknown year'})`);
    return null;
  }, 30 * 24 * 60 * 60); // 30 days cache for ID resolution
}

/**
 * Fetch raw catalog items list from Rotten Tomatoes CNAPI
 */
async function fetchRtBrowseList(listEndpoint: string, genreSlug: string | null, maxItems = 120): Promise<any[]> {
  const genreQuery = genreSlug ? `~genres:${genreSlug}` : '';
  const allItems: any[] = [];
  let after = '';
  let hasMore = true;
  let pagesFetched = 0;
  const maxPages = Math.ceil(maxItems / 30);

  while (hasMore && pagesFetched < maxPages) {
    pagesFetched++;
    const url = `https://www.rottentomatoes.com/cnapi/browse/${listEndpoint}${genreQuery}?after=${after}`;
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': RT_USER_AGENT,
          'Accept': 'application/json, text/plain, */*',
        },
        timeout: 15000,
      });

      const list = response.data?.grid?.list || [];
      allItems.push(...list);

      after = encodeURIComponent(response.data?.pageInfo?.endCursor || '');
      hasMore = Boolean(response.data?.pageInfo?.hasNextPage) && Boolean(after);

      if (list.length === 0) break;
    } catch (err: any) {
      logger.error(`Failed to fetch RT browse list from ${url}: ${err.message}`);
      break;
    }
  }

  return allItems;
}

/**
 * Main catalog fetcher for Rotten Tomatoes
 */
export async function getRottenTomatoesCatalog(
  type: string,
  catalogId: string,
  genreName: string,
  page: number,
  language: string,
  config: UserConfig,
  userUUID: string,
  includeVideos = false
): Promise<any[]> {
  try {
    const listEndpoint = getRtListEndpoint(catalogId, type);
    const genreSlug = normalizeRtGenre(genreName);
    const cleanCatalogId = catalogId.replace(/_(movie|series|anime|all)$/, '');
    const catalogConfig = config?.catalogs?.find(c => (c.id === catalogId || c.id === cleanCatalogId) && (c.type === type || c.displayType === type));
    const ttl = catalogConfig?.cacheTTL || 43200; // 12 hours default
    const resolvedUserUUID = userUUID || config?.userUUID || '';

    logger.info(`Fetching Rotten Tomatoes Catalog: ${catalogId} (${type}), Genre: ${genreSlug || 'all'}, Page: ${page}`);

    const cacheKey = `rt-catalog-items:${type}:${listEndpoint}:${genreSlug || 'all'}`;
    const rawItems: any[] = await cacheWrap(
      cacheKey,
      async () => fetchRtBrowseList(listEndpoint, genreSlug, 120),
      ttl,
      { enableErrorCaching: true, maxRetries: 2 }
    );

    if (!rawItems || rawItems.length === 0) {
      logger.warn(`No items returned for RT catalog: ${catalogId}`);
      return [];
    }

    const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string, 10) || 20;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const pageItems = rawItems.slice(startIndex, endIndex);

    if (pageItems.length === 0) {
      return [];
    }

    // Resolve items to Stremio metas concurrently
    const metas = await Promise.all(
      pageItems.map(async (item) => {
        try {
          const ids = await resolveRtItemToIds(item, type, config);
          if (!ids || (!ids.imdbId && !ids.tmdbId)) {
            return null;
          }

          const stremioId = ids.imdbId || `tmdb:${ids.tmdbId}`;
          const itemType = type === 'movie' ? 'movie' : 'series';

          const metaResult = await cacheWrapMetaSmart(
            resolvedUserUUID,
            stremioId,
            async () => getMeta(itemType, language, stremioId, config, resolvedUserUUID, includeVideos),
            undefined,
            { enableErrorCaching: true, maxRetries: 2, config },
            itemType as any,
            includeVideos
          );

          return metaResult?.meta || null;
        } catch (err: any) {
          logger.error(`Error processing RT item: ${err.message}`);
          return null;
        }
      })
    );

    const validMetas = metas.filter(Boolean);
    logger.success(`[RottenTomatoes] Successfully returned ${validMetas.length} items for ${catalogId} (Page ${page})`);
    return validMetas;
  } catch (error: any) {
    logger.error(`Error in getRottenTomatoesCatalog: ${error.message}`);
    return [];
  }
}

