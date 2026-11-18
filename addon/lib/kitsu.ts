// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import axios, { AxiosResponse } from 'axios';
import { LRUCache } from 'lru-cache';
import { cacheWrapGlobal } from './getCache.js';
import { normalizeKitsuBatchResponseForCache, normalizeKitsuDetailResponseForCache } from './kitsuCacheNormalizers.js';
import consola from 'consola';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('Kitsu');
const KITSU_DETAIL_CACHE_MAX = 2000;
const KITSU_DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const KITSU_BATCH_PAGE_SIZE = 20;

interface CachedKitsuDetailEntry {
  anime: any;
  categories: any[];
}

const kitsuDetailsByIdCache = new LRUCache<string, CachedKitsuDetailEntry>({
  max: KITSU_DETAIL_CACHE_MAX,
  ttl: KITSU_DETAIL_CACHE_TTL_MS,
});

type KitsuClient = {
  fetch: (model: string, config?: any) => Promise<any>;
  get: (model: string, config?: any) => Promise<any>;
};

let kitsuClientPromise: Promise<KitsuClient> | null = null;

// kitsu v11 is ESM-first, while the backend still compiles to CommonJS.
const loadKitsu = () =>
  Function('return import("kitsu")')() as Promise<{ default: new (options?: Record<string, unknown>) => KitsuClient }>;

async function getKitsuClient(): Promise<KitsuClient> {
  if (!kitsuClientPromise) {
    // The client defaults to 30s; one timeout governs every Kitsu path instead.
    const options: Record<string, unknown> = { timeout: kitsuTimeoutMs() };
    kitsuClientPromise = loadKitsu().then(({ default: Kitsu }) => new Kitsu(options));
  }

  return kitsuClientPromise;
}

const normalizeToFlat = (item: any): any => {
  if (!item.attributes) {
      return item; // already flat
  }
  const { attributes, ...rest } = item;
  return { ...rest, ...attributes };
};

function normalizeSearchText(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[\u2010-\u2015\u2212_\/-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getSearchTitleCandidates(item: KitsuAnime): string[] {
  const flatItem = normalizeToFlat(item);
  const titleCandidates: string[] = [];

  if (typeof flatItem?.canonicalTitle === 'string') {
    titleCandidates.push(flatItem.canonicalTitle);
  }

  if (flatItem?.titles && typeof flatItem.titles === 'object') {
    titleCandidates.push(
      ...Object.values(flatItem.titles).filter(
        (title): title is string => typeof title === 'string' && title.trim().length > 0
      )
    );
  }

  if (Array.isArray(flatItem?.abbreviatedTitles)) {
    titleCandidates.push(
      ...flatItem.abbreviatedTitles.filter(
        (title: unknown): title is string => typeof title === 'string' && title.trim().length > 0
      )
    );
  }

  return [...new Set(titleCandidates)];
}

function filterJunkSearchResults(results: KitsuAnime[], query: string): KitsuAnime[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return results;

  const queryTokens = normalizedQuery.split(/\s+/).filter(token => token.length > 0);

  const filteredResults = results.filter((item) => {
    const normalizedCandidates = getSearchTitleCandidates(item)
      .map(normalizeSearchText)
      .filter(Boolean);

    if (!normalizedCandidates.length) return false;

    const isMatch = normalizedCandidates.some((candidate) => {
      if (candidate.includes(normalizedQuery)) {
        return true;
      }

      return queryTokens.some((token) => candidate.includes(token));
    });

    return isMatch;
  });

  return filteredResults;
}

// Type definitions for Kitsu API responses
export interface KitsuAnimeAttributes {
  canonicalTitle: string;
  titles: {
    en_us?: string;
    en_jp?: string;
    en?: string;
    ja_jp?: string;
  };
  abbreviatedTitles?: string[];
  synopsis: string;
  description: string;
  subtype: string;
  status: string;
  startDate: string;
  endDate: string;
  episodeCount: number;
  episodeLength: number;
  totalLength: number;
  ageRating: string;
  ageRatingGuide: string;
  showType: string;
  nsfw: boolean;
  createdAt: string;
  updatedAt: string;
  slug: string;
  youtubeVideoId: string;
  coverImage: {
    tiny: string;
    small: string;
    large: string;
    original: string;
  } | null;
  posterImage: {
    tiny: string;
    small: string;
    medium: string;
    large: string;
    original: string;
  } | null;
  bannerImage: {
    tiny: string;
    small: string;
    large: string;
    original: string;
  } | null;
}

export interface KitsuAnime {

  id: string;

  type: string;

  attributes?: KitsuAnimeAttributes;

  relationships?: {

    episodes: {

      data: Array<{

        id: string;

        type: string;

      }>;

    };

    categories?: {

      data: Array<{

        id: string;

        type: string;

      }>;

    };

    mediaRelationships: {

      data: Array<{

        id: string;

        type: string;

      }>;

    };

  };

  [key: string]: any;

}

export interface KitsuEpisodeAttributes {
  number: number;
  seasonNumber: number;
  relativeNumber: number;
  title: string;
  synopsis: string;
  airdate: string;
  length: number;
  thumbnail: {
    tiny: string;
    small: string;
    medium: string;
    large: string;
    original: string;
  } | null;
  canonicalTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface KitsuEpisode {
  id: string;
  type: string;
  attributes: KitsuEpisodeAttributes;
}

interface KitsuApiResponse<T> {
  data: T[];
  links?: {
    first?: string;
    next?: string;
    last?: string;
  };
  meta?: {
    count: number;
  };
}

interface KitsuDirectApiResponse {
  data: KitsuAnime[];
  included?: any[];
  links?: {
    first?: string;
    next?: string;
    last?: string;
  };
  meta?: {
    count: number;
  };
}

/**
 * Searches Kitsu for anime by a text query.
 * @param query - The name of the anime to search for.
 * @returns A promise that resolves to an array of Kitsu anime resource objects.
 */
async function searchByName(query: string, subtypes: string[] = [], ageRating: string = 'G', offset: number = 0, limit: number = 20): Promise<KitsuAnime[]> {
  if (!query.trim()) return [];

  const results: KitsuAnime[] = [];
  const startTime = Date.now();

  try {
    const kitsu = await getKitsuClient();

    // Loop over all provided subtypes
    for (const subtype of subtypes.length ? subtypes : ['tv']) {
      let params: any = {
        'filter[text]': query,
        'filter[subtype]': subtype,
        'page[limit]': limit,
        'page[offset]': offset,
        'fields[anime]': 'canonicalTitle,titles,abbreviatedTitles,coverImage,posterImage,synopsis,description,startDate,endDate,slug,youtubeVideoId,status,subtype,episodeCount,episodeLength,ageRating'
      };
      if(ageRating.toLowerCase() !== 'none') {
        params['filter[ageRating]'] = ageRating;
      }

      let response = await kitsu.fetch('anime', {
        params: params
      });

      results.push(...(response.data ?? []));
    }

    // Track successful request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, true);

    return filterJunkSearchResults(results, query);
  } catch (error: any) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, false);
    
    // Log error to dashboard
    const status = error.response?.status;
    const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
    requestTracker.logProviderError('kitsu', errorType, `Search failed: ${error.message}`, {
      query,
      status
    });
    
    logger.error(`Error searching for "${query}":`, error.message);
    return filterJunkSearchResults(results, query);
  }
}



function assembleCachedKitsuDetails(requestedIds: string[], includeCategories: boolean) {
  const data: any[] = [];
  const includedMap = new Map<string, any>();

  for (const id of requestedIds) {
    const entry = kitsuDetailsByIdCache.get(id);
    if (!entry) continue;
    data.push(entry.anime);
    if (includeCategories) {
      for (const cat of entry.categories) {
        if (cat?.id) includedMap.set(String(cat.id), cat);
      }
    }
  }

  return {
    data,
    included: includeCategories ? Array.from(includedMap.values()) : [],
    meta: { count: data.length },
  };
}

/**
 * Fetches the full details for multiple anime by their Kitsu IDs with pagination support.
 * @param ids - An array of Kitsu IDs.
 * @returns A promise that resolves to an array of Kitsu anime resource objects.
 */
async function getMultipleAnimeDetails(ids: (string | number)[], appends: string = 'categories') {
  if (!ids || ids.length === 0) {
    return null;
  }

  const requestedIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  if (requestedIds.length === 0) {
    return null;
  }

  const normalizedAppends = (appends || '').trim();
  const canUseItemCache = normalizedAppends === 'categories' || normalizedAppends === '';
  const fetchIds = canUseItemCache
    ? requestedIds.filter((id) => !kitsuDetailsByIdCache.has(id))
    : requestedIds;

  if (canUseItemCache && fetchIds.length === 0) {
    return assembleCachedKitsuDetails(requestedIds, normalizedAppends === 'categories');
  }

  const startTime = Date.now();

  try {
    logger.info(`Fetching details for ${fetchIds.length} IDs: ${fetchIds.join(',')}`);

    const allData: KitsuAnime[] = [];
    const allIncluded: any[] = [];
    let pageCount = 0;

    const effectiveInclude = canUseItemCache ? 'categories' : normalizedAppends;
    const chunks: string[][] = [];
    for (let i = 0; i < fetchIds.length; i += KITSU_BATCH_PAGE_SIZE) {
      chunks.push(fetchIds.slice(i, i + KITSU_BATCH_PAGE_SIZE));
    }

    for (const chunk of chunks) {
      const includeQuery = effectiveInclude ? `&include=${effectiveInclude}` : '';
      let nextUrl: string | undefined = `https://kitsu.io/api/edge/anime?filter[id]=${chunk.join(',')}${includeQuery}&page[limit]=${KITSU_BATCH_PAGE_SIZE}`;
      logger.debug(`Direct API URL: ${nextUrl}`);

      while (nextUrl) {
        pageCount++;
        logger.debug(`Fetching page ${pageCount}...`);

        const response: AxiosResponse<KitsuDirectApiResponse> = await axios.get(nextUrl, {
          headers: {
            'Accept': 'application/vnd.api+json',
            'Content-Type': 'application/vnd.api+json'
          },
          timeout: kitsuTimeoutMs()
        });

        const pageData = response.data?.data || [];
        const pageIncluded = response.data?.included || [];
        logger.debug(`Page ${pageCount} received ${pageData.length} results, ${pageIncluded.length} included items`);

        allData.push(...pageData);
        allIncluded.push(...pageIncluded);

        nextUrl = response.data?.links?.next;
        if (nextUrl) {
          logger.debug(`Found next page, continuing pagination...`);
        }
      }
    }

    logger.debug(`Total results after pagination: ${allData.length} data items, ${allIncluded.length} included items across ${pageCount} page(s)`);
    const receivedIds = allData.map(item => item.id);
    logger.success(`Received IDs: ${receivedIds.join(',')}`);

    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, true);

    const normalized = normalizeKitsuBatchResponseForCache({
      data: allData,
      included: allIncluded,
      meta: { count: allData.length }
    });

    if (canUseItemCache && normalized?.data) {
      const categoriesById = new Map<string, any>();
      for (const inc of normalized.included || []) {
        if (inc?.type === 'categories' && inc?.id) {
          categoriesById.set(String(inc.id), inc);
        }
      }
      for (const anime of normalized.data) {
        if (!anime?.id) continue;
        const catRefs = anime.relationships?.categories?.data || [];
        const categories = catRefs
          .map((ref: any) => categoriesById.get(String(ref.id)))
          .filter(Boolean);
        kitsuDetailsByIdCache.set(String(anime.id), { anime, categories });
      }
      return assembleCachedKitsuDetails(requestedIds, normalizedAppends === 'categories');
    }

    return normalized;
  } catch (error: any) {
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, false);

    const status = error.response?.status;
    const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
    requestTracker.logProviderError('kitsu', errorType, `getMultipleAnimeDetails failed: ${error.message}`, {
      ids: fetchIds.slice(0, 5).join(','),
      status
    });

    logger.error(`Error fetching details for IDs ${fetchIds.join(',')}:`, (error as Error).message);
    return null;
  }
}

/**
 * Fetches episode data for an anime by its Kitsu ID.
 * @param kitsuId - The Kitsu anime ID.
 * @returns A promise that resolves to an array of episode objects.
 */
async function getAnimeEpisodes(kitsuId: string | number): Promise<KitsuEpisode[]> {
  if (!kitsuId) return [];
  
  const cacheKey = `kitsu-episodes:v2:${kitsuId}`;
  const cacheTTL = 3600; // 1 hour cache for episode data
  
  return cacheWrapGlobal(cacheKey, async () => {
    logger.info(`Fetching episodes for ID ${kitsuId}`);
    const startTime = Date.now();
    
    try {
      const params = {
        page: { limit: 20 }
      };
      
      const allEpisodes = await _fetchEpisodesRecursively(`anime/${kitsuId}/episodes`, params);
      logger.success(`Total episodes fetched: ${allEpisodes.length}`);
      
      // Track successful request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('kitsu', responseTime, true);
      
      return allEpisodes;
    } catch (error: any) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('kitsu', responseTime, false);
      
      const status = error.response?.status;
      const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
      requestTracker.logProviderError('kitsu', errorType, `getAnimeEpisodes failed: ${error.message}`, {
        kitsuId,
        status
      });
      
      logger.error(`Error fetching episodes for ID ${kitsuId}:`, (error as Error).message);
      return [];
    }
  }, cacheTTL);
}

async function _fetchEpisodesRecursively(
  endpoint: string, 
  params: { page: { limit: number } }, 
  offset: number = 0
): Promise<KitsuEpisode[]> {
  const kitsu = await getKitsuClient();
  const currentParams = { 
    ...params, 
    page: { ...params.page, offset } 
  };
  
  const response = await kitsu.get(endpoint, { params: currentParams });
  
  if (response.links && response.links.next) {
    const nextOffset = offset + response.data.length;
    const nextEpisodes = await _fetchEpisodesRecursively(endpoint, params, nextOffset);
    return response.data.concat(nextEpisodes);
  }
  
  return response.data;
}

// -------------------- Helpers --------------------

function kitsuTimeoutMs(): number {
  return envInt('KITSU_REQUEST_TIMEOUT_MS', 10000, 500);
}

async function fetchRelationshipList(url?: string, attributeKey: 'name' | 'title' = 'name'): Promise<string[]> {
  if (!url) return []
  try {
    // This one had no timeout at all, so a slow Kitsu held the request open.
    const res = await fetch(url, { signal: AbortSignal.timeout(kitsuTimeoutMs()) })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return []
    }
    const json = await res.json()
    return ((json as any).data || [])
      .map((i: any) => i.attributes?.[attributeKey])
      .filter((value: any) => typeof value === 'string' && value.trim().length > 0)
  } catch {
    return []
  }
}

// -------------------- Main fetch --------------------

/**
 * Fetches a Kitsu anime by ID, including categories and characters.
 */
 async function getAnimeDetails(kitsuId: string | number) {
  if (!kitsuId) return null
  
  const startTime = Date.now();

  try {
    const kitsu = await getKitsuClient();
    const response = await kitsu.get(`anime/${kitsuId}`, {
      params: {
        include: 'episodes,categories,characters.character,mediaRelationships.destination'
      }
    })

    const anime = response.data
    const included = response.included || []

    // try to read from included first
    let genres = included
      .filter((i: any) => i.type === 'categories')
      .map((i: any) => i.attributes?.title)
      .filter((value: any) => typeof value === 'string' && value.trim().length > 0)
    let characters = included
      .filter((i: any) => i.type === 'characters')
      .map((i: any) => i.attributes?.name)
      .filter((value: any) => typeof value === 'string' && value.trim().length > 0)

    // fallback if missing
    if (!genres.length)
      genres = await fetchRelationshipList(anime.relationships?.categories?.links?.related, 'title')
    if (!characters.length)
      characters = await fetchRelationshipList(anime.relationships?.characters?.links?.related, 'name')

    // Track successful request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, true);

    return normalizeKitsuDetailResponseForCache({ data: anime, included, genres, characters })
  } catch (error: any) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, false);
    
    const status = error.response?.status;
    const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
    requestTracker.logProviderError('kitsu', errorType, `getAnimeDetails failed: ${error.message}`, {
      kitsuId,
      status
    });
    
    logger.error(`Error fetching anime details for ID ${kitsuId}:`, (error as Error).message)
    return null
  }
}

export {
  searchByName,
  getMultipleAnimeDetails,
  getAnimeEpisodes,
  getAnimeDetails
};

// CommonJS compatibility
module.exports = {
  searchByName,
  getMultipleAnimeDetails,
  getAnimeEpisodes,
  getAnimeDetails
};
