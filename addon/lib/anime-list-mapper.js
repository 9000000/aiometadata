const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const redis = require('./redisClient');
const xml2js = require('xml2js');
const consola = require('consola');
const { writeFileAtomic } = require('../utils/atomicWrite');


const logger = consola.withTag('AnimeListMapper');

// Anime-Lists XML file URL
const REMOTE_ANIME_LIST_URL = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/refs/heads/master/anime-list-full.xml';
const LOCAL_CACHE_PATH = path.join(process.cwd(), 'addon', 'data', 'anime-list-full.xml.cache');
const REDIS_ETAG_KEY = 'anime-list-xml-etag';
const UPDATE_INTERVAL_HOURS = parseInt(process.env.ANIME_LIST_XML_UPDATE_INTERVAL_HOURS) || 24; // Update every 24 hours (configurable)

// Data structures to hold parsed mappings
let animeListMap = new Map(); // anidbid -> anime entry
let tvdbToAnimeMap = new Map(); // tvdbid -> array of anime entries
let tmdbToAnimeMap = new Map(); // tmdbid -> array of anime entries
let imdbToAnimeMap = new Map(); // imdbid -> array of anime entries
let sameSeasonEntryGroupCache = new Map(); // `${tvdbId}|${defaulttvdbseason}` -> grouped entries
let episodeMappingStringCache = new Map(); // mapping string -> parsed ranges
let isInitialized = false;
let updateInterval = null;

/**
 * Parses the XML data and builds indexed maps for fast lookups
 */
function processAndIndexXmlData(xmlData) {
  animeListMap.clear();
  tvdbToAnimeMap.clear();
  tmdbToAnimeMap.clear();
  imdbToAnimeMap.clear();
  sameSeasonEntryGroupCache.clear();
  episodeMappingStringCache.clear();

  const parser = new xml2js.Parser({ explicitArray: true });
  
  return new Promise((resolve, reject) => {
    parser.parseString(xmlData, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        const animeList = result['anime-list'].anime || [];
        
        for (const anime of animeList) {
          const anidbid = parseInt(anime.$.anidbid, 10);
          if (!anidbid) continue;

          const parsed = buildParsedEntry(anime);

          // Store by AniDB ID
          animeListMap.set(anidbid, anime);

          // Index by TVDB ID
          if (parsed.tvdbId) {
            if (!tvdbToAnimeMap.has(parsed.tvdbId)) {
              tvdbToAnimeMap.set(parsed.tvdbId, []);
            }
            tvdbToAnimeMap.get(parsed.tvdbId).push(anime);
          }

          // Index by TMDB TV ID
          if (anime.$.tmdbtv) {
            const tmdbId = parseInt(anime.$.tmdbtv);
            if (!tmdbToAnimeMap.has(tmdbId)) {
              tmdbToAnimeMap.set(tmdbId, []);
            }
            tmdbToAnimeMap.get(tmdbId).push(anime);
          }

          // Index by IMDB ID (for movies/standalone content)
          if (anime.$.imdbid) {
            const imdbIds = anime.$.imdbid.split(',').map(id => id.trim());
            for (const imdbId of imdbIds) {
              if (imdbId && imdbId !== 'unknown') {
                if (!imdbToAnimeMap.has(imdbId)) {
                  imdbToAnimeMap.set(imdbId, []);
                }
                imdbToAnimeMap.get(imdbId).push(anime);
              }
            }
          }
        }

        isInitialized = true;
        logger.info(`Successfully loaded and indexed ${animeListMap.size} anime mappings.`);
        logger.info(`TVDB mappings: ${tvdbToAnimeMap.size}, TMDB mappings: ${tmdbToAnimeMap.size}, IMDB mappings: ${imdbToAnimeMap.size}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Downloads and processes the anime-list XML file.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 * @param {boolean} force - If true, bypass ETag check and force re-download
 */
async function downloadAndProcessAnimeList(force = false, skipReloadOnUnchangedEtag = false) {
  const useRedisCache = redis && redis.status === 'ready';

  try {
    if (useRedisCache && !force) {
      try {
        const savedEtag = await redis.get(REDIS_ETAG_KEY);
        const headers = (await axios.head(REMOTE_ANIME_LIST_URL, { timeout: 10000 })).headers;
        const remoteEtag = headers.etag;

        logger.debug(`Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

        if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
          if (skipReloadOnUnchangedEtag && isInitialized) {
            logger.info('No changes detected during scheduled refresh. Keeping existing in-memory mappings.');
            try {
              await redis.setex('anime_list:last_update', 86400 * 7, Date.now().toString());
              logger.debug('Maintenance task tracked: anime-list scheduled no-op');
            } catch (trackingError) {
              logger.warn('Failed to track maintenance task:', trackingError.message);
            }

            return { success: true, message: 'Unchanged (scheduled no-op)', count: animeListMap.size };
          }

          try {
            logger.info('No changes detected. Loading from local disk cache...');
            const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
            await processAndIndexXmlData(fileContent);
            
            // Track maintenance task completion even when loading from cache
            try {
              await redis.setex('anime_list:last_update', 86400 * 7, Date.now().toString());
              logger.debug('Maintenance task tracked: anime-list loaded from cache');
            } catch (trackingError) {
              logger.warn('Failed to track maintenance task:', trackingError.message);
            }
            
            return { success: true, message: 'Loaded from cache (no changes)', count: animeListMap.size };
          } catch (e) {
            logger.warn('ETag matched, but local cache was unreadable. Forcing re-download.');
          }
        }
      } catch (redisError) {
        logger.warn('Redis error, proceeding without cache:', redisError.message);
      }
    } else if (force) {
      logger.info('Force update requested. Bypassing ETag check.');
    } else {
      logger.debug('Redis cache is disabled or unavailable. Proceeding to download.');
    }

    logger.info('Downloading anime-list XML...');
    
    // Record start time for maintenance tracking
    const startTime = Date.now();
    
    const response = await axios.get(REMOTE_ANIME_LIST_URL, { 
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 300; // default
      }
    });
    const xmlData = response.data;

    await processAndIndexXmlData(xmlData);
    await writeFileAtomic(LOCAL_CACHE_PATH, xmlData, 'utf-8');

    if (useRedisCache) {
      try {
        await redis.set(REDIS_ETAG_KEY, response.headers.etag);
      } catch (redisError) {
        logger.warn('Failed to save ETag to Redis:', redisError.message);
      }
    }
    
    // Track maintenance task completion
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    if (useRedisCache) {
      try {
        await redis.setex('anime_list:last_update', 86400 * 7, startTime.toString());
        logger.info(`Maintenance task tracked: anime-list update completed in ${duration}ms`);
      } catch (trackingError) {
        logger.warn('Failed to track maintenance task:', trackingError.message);
      }
    }
    
    return { success: true, message: 'Downloaded and updated', count: animeListMap.size };

  } catch (error) {
    logger.error(`An error occurred during remote download: ${error.message}`);
    logger.info('Attempting to fall back to local disk cache...');

    try {
      const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
      logger.info('Successfully loaded data from local cache on fallback.');
      await processAndIndexXmlData(fileContent);
      
      // Track maintenance task completion for fallback cache load
      if (useRedisCache) {
        try {
          await redis.setex('anime_list:last_update', 86400 * 7, Date.now().toString());
          logger.debug('Maintenance task tracked: anime-list loaded from cache (fallback)');
        } catch (trackingError) {
          logger.warn('Failed to track maintenance task:', trackingError.message);
        }
      }
      
      return { success: true, message: 'Loaded from local cache (fallback)', count: animeListMap.size };
    } catch (fallbackError) {
      logger.error('CRITICAL: Fallback to local cache also failed. Mapper will be empty.');
      return { success: false, message: `Failed to update: ${error.message}`, count: 0 };
    }
  }
}

/**
 * Initializes the anime-list mapper on addon startup.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 */
async function initializeAnimeListMapper() {
  if (isInitialized) return;

  await downloadAndProcessAnimeList();

  // Schedule periodic updates
  if (!updateInterval) {
    const intervalMs = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
    updateInterval = setInterval(async () => {
      logger.info(`Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
      try {
        await downloadAndProcessAnimeList(false, true);
        logger.info('Scheduled update completed successfully.');
      } catch (error) {
        logger.error('Scheduled update failed:', error.message);
      }
    }, intervalMs);
    updateInterval.unref?.();

    logger.info(`Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
  }
}

function toIntId(id) {
  return typeof id === 'number' ? Math.trunc(id) : parseInt(id, 10);
}

/**
 * Gets anime entry by AniDB ID
 */
function getAnimeByAnidbId(anidbId) {
  if (!isInitialized) return null;
  return animeListMap.get(toIntId(anidbId)) || null;
}

/**
 * Gets anime entries by TVDB ID
 */
function getAnimeByTvdbId(tvdbId) {
  if (!isInitialized) return [];
  return tvdbToAnimeMap.get(toIntId(tvdbId)) || [];
}

/**
 * Gets anime entries by TMDB ID
 */
function getAnimeByTmdbId(tmdbId) {
  if (!isInitialized) return [];
  return tmdbToAnimeMap.get(toIntId(tmdbId)) || [];
}

/**
 * Gets anime entries by IMDB ID
 */
function getAnimeByImdbId(imdbId) {
  if (!isInitialized) return [];
  return imdbToAnimeMap.get(imdbId) || [];
}

/**
 * Gets the mapping list for a specific anime entry
 */
function getMappingList(animeEntry) {
  if (!animeEntry || !animeEntry['mapping-list']) {
    return [];
  }
  
  const mappingList = animeEntry['mapping-list'];
  
  // Handle the XML structure: mapping-list is an array with one element containing mappings
  if (Array.isArray(mappingList) && mappingList.length > 0) {
    const mappings = mappingList[0].mapping;
    if (mappings) {
      return Array.isArray(mappings) ? mappings : [mappings];
    }
  }
  
  return [];
}

function buildParsedEntry(anime) {
  const attrs = anime.$ || {};
  const anidbId = parseInt(attrs.anidbid, 10);
  const tvdbId = (attrs.tvdbid && attrs.tvdbid !== 'unknown' && attrs.tvdbid !== 'hentai')
    ? parseInt(attrs.tvdbid, 10)
    : null;
  const defaultTvdbSeason = attrs.defaulttvdbseason;
  const defaultSeasonNum = (defaultTvdbSeason !== 'a' && defaultTvdbSeason !== '0')
    ? parseInt(defaultTvdbSeason, 10)
    : NaN;
  const episodeOffset = parseInt(attrs.episodeoffset, 10) || 0;
  const rawMappings = getMappingList(anime);
  const mappings = rawMappings.map((m) => {
    const mAttrs = m.$ || {};
    const hasStart = Boolean(mAttrs.start);
    const hasEnd = Boolean(mAttrs.end);
    return {
      raw: m,
      anidbSeason: parseInt(mAttrs.anidbseason, 10),
      tvdbSeason: mAttrs.tvdbseason !== undefined ? parseInt(mAttrs.tvdbseason, 10) : undefined,
      offset: parseInt(mAttrs.offset, 10) || 0,
      hasStart,
      hasEnd,
      start: hasStart ? parseInt(mAttrs.start, 10) : NaN,
      end: hasEnd ? parseInt(mAttrs.end, 10) : NaN,
      ranges: m._ ? getCachedEpisodeMapping(m._) : null,
    };
  });
  const parsed = {
    anidbId,
    tvdbId: tvdbId && !isNaN(tvdbId) ? tvdbId : null,
    defaultTvdbSeason,
    defaultSeasonNum,
    episodeOffset,
    mappings,
  };
  Object.defineProperty(anime, '_parsed', { value: parsed, enumerable: false, configurable: true });
  return parsed;
}

function getParsedEntry(anime) {
  return anime._parsed || buildParsedEntry(anime);
}

function getSameSeasonEntryGroup(animeEntry) {
  const key = `${animeEntry.$.tvdbid}|${animeEntry.$.defaulttvdbseason}`;
  const cached = sameSeasonEntryGroupCache.get(key);
  if (cached) {
    return cached;
  }

  const allEntries = getAnimeByTvdbId(getParsedEntry(animeEntry).tvdbId ?? animeEntry.$.tvdbid);
  const sameSeasonEntries = allEntries.filter(
    (entry) => entry.$.defaulttvdbseason === animeEntry.$.defaulttvdbseason
  );

  const sortedEntries = [...sameSeasonEntries].sort(
    (a, b) => getParsedEntry(a).episodeOffset - getParsedEntry(b).episodeOffset
  );

  const sortedOffsetEntries = sortedEntries.map((entry) => ({
    entry,
    offset: getParsedEntry(entry).episodeOffset,
  }));

  const indexByAnidbId = new Map();
  for (let i = 0; i < sortedEntries.length; i++) {
    indexByAnidbId.set(getParsedEntry(sortedEntries[i]).anidbId, i);
  }

  const group = {
    sameSeasonEntries,
    sortedEntries,
    sortedOffsetEntries,
    indexByAnidbId,
  };

  sameSeasonEntryGroupCache.set(key, group);
  return group;
}

function getCachedEpisodeMapping(mappingString) {
  if (!mappingString) return [];

  if (episodeMappingStringCache.has(mappingString)) {
    return episodeMappingStringCache.get(mappingString);
  }

  const parsed = parseEpisodeMapping(mappingString);
  episodeMappingStringCache.set(mappingString, parsed);
  return parsed;
}

/**
 * Parses episode mapping string (e.g., ";1-2;3-4;")
 */
function parseEpisodeMapping(mappingString) {
  if (!mappingString) return [];
  
  const mappings = [];
  const parts = mappingString.split(';').filter(part => part.trim());
  
  for (const part of parts) {
    const [start, end] = part.split('-').map(num => parseInt(num.trim()));
    if (!isNaN(start) && !isNaN(end)) {
      mappings.push({ start, end });
    }
  }
  
  return mappings;
}

/**
 * Gets episode mappings for a specific season
 */
function getSeasonMappings(animeEntry, anidbSeason, targetType = 'tvdb') {
  const mappingList = getMappingList(animeEntry);
  
  for (const mapping of mappingList) {
    const mappingAnidbSeason = parseInt(mapping.$.anidbseason);
    const targetSeason = parseInt(mapping.$[`${targetType}season`]);
    
    if (mappingAnidbSeason === anidbSeason) {
      return {
        targetSeason,
        episodeMappings: getCachedEpisodeMapping(mapping._)
      };
    }
  }
  
  return null;
}

/**
 * Resolves AniDB episode information from TVDB episode details
 * @param {number} tvdbId - The TVDB series ID
 * @param {number} tvdbSeason - The TVDB season number
 * @param {number} tvdbEpisode - The TVDB episode number within that season
 * @returns {Object|null} AniDB episode info or null if not found
 */
function resolveAnidbEpisodeFromTvdbEpisode(tvdbId, tvdbSeason, tvdbEpisode) {
  if (!isInitialized) return null;

  const animeEntries = getAnimeByTvdbId(tvdbId);
  if (!animeEntries || animeEntries.length === 0) {
    return null;
  }

  for (const animeEntry of animeEntries) {
    const parsed = getParsedEntry(animeEntry);
    const defaultTvdbSeason = parsed.defaultTvdbSeason;

    if (defaultTvdbSeason === 'a') {
      const result = handleAbsoluteNumbering(animeEntry, parsed, tvdbSeason, tvdbEpisode);
      if (result) return result;
    } else if (defaultTvdbSeason === '0') {
      continue;
    } else if (parsed.defaultSeasonNum === tvdbSeason) {
      const result = handleRegularSeasonMapping(animeEntry, parsed, tvdbSeason, tvdbEpisode);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Handle absolute episode numbering (like One Piece)
 */
function handleAbsoluteNumbering(animeEntry, parsed, tvdbSeason, tvdbEpisode) {
  for (const mapping of parsed.mappings) {
    if (mapping.tvdbSeason === tvdbSeason) {
      const offset = mapping.offset;
      if (mapping.hasStart && mapping.hasEnd) {
        const anidbEpisode = tvdbEpisode - offset;
        if (anidbEpisode >= mapping.start && anidbEpisode <= mapping.end) {
          return {
            anidbId: parsed.anidbId,
            anidbSeason: mapping.anidbSeason,
            anidbEpisode,
            episodeOffset: offset,
            animeName: animeEntry.name,
            mappingInfo: {
              type: 'absolute_numbering',
              start: mapping.start,
              end: mapping.end,
              offset,
            },
          };
        }
      } else if (mapping.hasStart && !mapping.hasEnd) {
        const anidbEpisode = tvdbEpisode - offset;
        if (anidbEpisode >= mapping.start) {
          return {
            anidbId: parsed.anidbId,
            anidbSeason: mapping.anidbSeason,
            anidbEpisode,
            episodeOffset: offset,
            animeName: animeEntry.name,
            mappingInfo: {
              type: 'absolute_numbering_open',
              start: mapping.start,
              offset,
            },
          };
        }
      }
    }
  }

  return null;
}

/**
 * Handle regular season mapping with episode offset
 */
function handleRegularSeasonMapping(animeEntry, parsed, tvdbSeason, tvdbEpisode) {
  const episodeOffset = parsed.episodeOffset;
  const seasonGroup = getSameSeasonEntryGroup(animeEntry);
  const sameSeasonEntries = seasonGroup.sameSeasonEntries;

  if (sameSeasonEntries.length === 1) {
    const anidbEpisode = tvdbEpisode - episodeOffset;
    if (anidbEpisode <= 0) {
      return null;
    }

    return {
      anidbId: parsed.anidbId,
      anidbSeason: 1,
      anidbEpisode,
      episodeOffset,
      animeName: animeEntry.name,
      mappingInfo: {
        type: 'regular_season_direct',
        episodeOffset,
      },
    };
  }

  if (parsed.mappings.length > 0) {
    for (const mapping of parsed.mappings) {
      if (mapping.hasStart && mapping.hasEnd) {
        const start = mapping.start;
        const end = mapping.end;
        if (tvdbEpisode >= start + episodeOffset && tvdbEpisode <= end + episodeOffset) {
          const anidbEpisode = tvdbEpisode - episodeOffset;
          if (anidbEpisode <= 0) {
            return null;
          }

          return {
            anidbId: parsed.anidbId,
            anidbSeason: mapping.anidbSeason,
            anidbEpisode,
            episodeOffset,
            animeName: animeEntry.name,
            mappingInfo: {
              type: 'regular_season_with_mapping',
              start,
              end,
              episodeOffset,
            },
          };
        }
      }
    }
  }

  if (sameSeasonEntries.length > 1) {
    const currentEntryIndex = seasonGroup.indexByAnidbId.get(parsed.anidbId);
    if (currentEntryIndex !== undefined) {
      const nextEntry = seasonGroup.sortedOffsetEntries[currentEntryIndex + 1];
      if (nextEntry && tvdbEpisode > nextEntry.offset) {
        return null;
      }
    }
  }

  const anidbEpisode = tvdbEpisode - episodeOffset;
  if (anidbEpisode <= 0) {
    return null;
  }

  return {
    anidbId: parsed.anidbId,
    anidbSeason: 1,
    anidbEpisode,
    episodeOffset,
    animeName: animeEntry.name,
    mappingInfo: {
      type: 'regular_season',
      episodeOffset,
    },
  };
}

/**
 * Resolves TVDB episode details from AniDB identifiers
 * @param {number} anidbId - AniDB series ID
 * @param {number} anidbSeason - AniDB season number
 * @param {number} anidbEpisode - AniDB episode number
 * @returns {Object|null} TVDB episode info or null if not found
 */
function resolveTvdbEpisodeFromAnidbEpisode(anidbId, anidbSeason, anidbEpisode) {
  if (!isInitialized) return null;

  const animeEntry = getAnimeByAnidbId(anidbId);
  if (!animeEntry) {
    return null;
  }

  const parsed = getParsedEntry(animeEntry);
  const tvdbId = parsed.tvdbId;
  if (!tvdbId) {
    return null;
  }

  const defaultTvdbSeason = parsed.defaultTvdbSeason;
  const episodeOffset = parsed.episodeOffset;

  const buildResult = (season, episode, info) => ({
    tvdbId,
    tvdbSeason: season,
    tvdbEpisode: episode,
    animeName: animeEntry.name,
    mappingInfo: info,
  });

  if (defaultTvdbSeason === 'a') {
    for (const mapping of parsed.mappings) {
      if (mapping.anidbSeason !== anidbSeason) continue;
      if (mapping.tvdbSeason === undefined) continue;

      const tvdbSeason = mapping.tvdbSeason;
      const offset = mapping.offset;

      if (mapping.hasStart && mapping.hasEnd) {
        if (anidbEpisode >= mapping.start && anidbEpisode <= mapping.end) {
          return buildResult(tvdbSeason, anidbEpisode + offset, {
            type: 'absolute_numbering',
            start: mapping.start,
            end: mapping.end,
            offset,
          });
        }
      } else if (mapping.hasStart && !mapping.hasEnd) {
        if (anidbEpisode >= mapping.start) {
          return buildResult(tvdbSeason, anidbEpisode + offset, {
            type: 'absolute_numbering_open',
            start: mapping.start,
            offset,
          });
        }
      } else if (mapping.ranges) {
        for (const range of mapping.ranges) {
          if (anidbEpisode >= range.start && anidbEpisode <= range.end) {
            return buildResult(tvdbSeason, anidbEpisode + offset, {
              type: 'absolute_numbering_range',
              range,
              offset,
            });
          }
        }
      }
    }
    return null;
  }

  if (defaultTvdbSeason === '0') {
    return null;
  }

  const tvdbSeason = parsed.defaultSeasonNum;
  const seasonGroup = getSameSeasonEntryGroup(animeEntry);
  const sameSeasonEntries = seasonGroup.sameSeasonEntries;

  if (sameSeasonEntries.length === 1) {
    const tvdbEpisode = anidbEpisode + episodeOffset;
    if (tvdbEpisode <= 0) {
      return null;
    }

    return buildResult(tvdbSeason, tvdbEpisode, {
      type: 'regular_season_direct',
      episodeOffset,
    });
  }

  for (const mapping of parsed.mappings) {
    if (mapping.anidbSeason !== anidbSeason) continue;

    const targetSeason = mapping.tvdbSeason || tvdbSeason;
    const offset = mapping.offset || episodeOffset;

    if (mapping.hasStart && mapping.hasEnd) {
      if (anidbEpisode >= mapping.start && anidbEpisode <= mapping.end) {
        const delta = anidbEpisode - mapping.start;
        const tvdbEpisode = mapping.start + offset + delta;
        return buildResult(targetSeason, tvdbEpisode, {
          type: 'regular_season_with_mapping',
          start: mapping.start,
          end: mapping.end,
          offset,
        });
      }
    }
  }

  if (sameSeasonEntries.length > 1) {
    const sortedEntries = seasonGroup.sortedOffsetEntries;
    const currentIndex = seasonGroup.indexByAnidbId.get(parsed.anidbId);

    if (currentIndex !== undefined) {
      const currentOffset = sortedEntries[currentIndex].offset;
      const nextOffset = sortedEntries[currentIndex + 1]?.offset;

      if (anidbEpisode < 1) {
        return null;
      }

      if (nextOffset !== undefined && anidbEpisode + currentOffset > nextOffset) {
        return null;
      }

      const tvdbEpisode = anidbEpisode + currentOffset;
      if (tvdbEpisode <= 0) {
        return null;
      }

      return buildResult(tvdbSeason, tvdbEpisode, {
        type: 'regular_season_offset_range',
        episodeOffset: currentOffset,
        nextOffset,
      });
    }
  }

  const tvdbEpisode = anidbEpisode + episodeOffset;
  if (tvdbEpisode <= 0) {
    return null;
  }

  return buildResult(tvdbSeason, tvdbEpisode, {
    type: 'regular_season_fallback',
    episodeOffset,
  });
}

module.exports = {
  initializeAnimeListMapper,
  getAnimeByAnidbId,
  getAnimeByTvdbId,
  getAnimeByTmdbId,
  getAnimeByImdbId,
  getMappingList,
  parseEpisodeMapping,
  getSeasonMappings,
  resolveAnidbEpisodeFromTvdbEpisode,
  resolveTvdbEpisodeFromAnidbEpisode,
  forceUpdateAnimeListXml,
  getAnimeListXmlStats,
  isInitialized: () => isInitialized,
  // Debug exports
  tvdbToAnimeMap: () => tvdbToAnimeMap,
  animeListMap: () => animeListMap
};

/**
 * Force update the anime-list XML mapping
 * @returns {Promise<Object>} Result object with success, message, and count
 */
async function forceUpdateAnimeListXml() {
  logger.info('Force update requested for anime-list XML...');
  try {
    const result = await downloadAndProcessAnimeList(true);
    return result;
  } catch (error) {
    logger.error('Force update failed:', error.message);
    return { success: false, message: `Force update failed: ${error.message}`, count: animeListMap.size };
  }
}

/**
 * Get stats for the anime-list XML mapper (for dashboard display)
 * @returns {Object} Stats object with counts, updateInterval, and initialized status
 */
function getAnimeListXmlStats() {
  return {
    count: animeListMap.size,
    tvdbMappings: tvdbToAnimeMap.size,
    tmdbMappings: tmdbToAnimeMap.size,
    imdbMappings: imdbToAnimeMap.size,
    updateIntervalHours: UPDATE_INTERVAL_HOURS,
    initialized: isInitialized
  };
}
