#!/usr/bin/env node
/**
 * crawl-franchises.js
 * -------------------------------------------------------------------
 * Hệ thống cào & làm giàu dữ liệu Franchise Collections nội bộ cho AIOMetadata.
 * 
 * Tính năng chính:
 * 1. Hoàn toàn tự chủ: Không phụ thuộc vào repo GitHub bên thứ ba.
 * 2. Hỗ trợ đa nguồn & đa chiến lược:
 *    - curated_enrich: Giữ thứ tự cốt truyện / timeline chuẩn & làm giàu metadata từ TMDB / Cinemeta.
 *    - tmdb_collection: Cào toàn bộ phim từ TMDB Collection ID.
 *    - tmdb_discover: Cào theo Studio/Company (Marvel Studios, DC Studios, Lucasfilm,...).
 * 3. Tối ưu tốc độ cao: Fail-fast API auth check + Concurrent pool + Cinemeta fallback.
 * 4. Tự động đồng bộ hóa đăng ký catalog frontend và dịch thuật i18n.
 * -------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, 'sources/franchises-manifest.json');
const OUT_DIR = path.join(__dirname, '../addon/static/franchises');
const CATALOG_TYPES_PATH = path.join(__dirname, '../addon/static/catalog-types.json');
const TRANSLATIONS_PATH = path.join(__dirname, '../addon/static/translations.json');
const FRONTEND_CATALOGS_PATH = path.join(__dirname, '../configure/src/data/franchiseCatalogs.json');

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io/meta';
const CONCURRENCY = 10;
const ITEM_TIMEOUT_MS = 4000;

// API Key resolution
let tmdbApiKey = process.env.TMDB_API_KEY || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY || '';
let tmdbAvailable = !!tmdbApiKey;

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// Format readable display name
function formatName(name) {
  name = name.replace('.json', '');
  name = name.replace(/^(dc|marvel|star_wars)_/, '');
  name = name.replace(/Data$/, '');
  name = name.replace(/([A-Z])/g, ' $1').trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Kiểm tra tính hợp lệ của TMDB API Key khi khởi động
 */
async function verifyTmdbKey() {
  if (!tmdbApiKey) {
    console.log('ℹ️ Không có TMDB_API_KEY được cấu hình -> Sử dụng Cinemeta & Manifest Cache làm nguồn.');
    tmdbAvailable = false;
    return;
  }

  try {
    const res = await fetch(`${TMDB_BASE_URL}/configuration?api_key=${tmdbApiKey}`);
    if (res.status === 401 || res.status === 403) {
      console.warn('⚠️ TMDB_API_KEY không hợp lệ hoặc đã hết hạn -> Tự động chuyển sang Cinemeta fallback.');
      tmdbAvailable = false;
    } else if (res.ok) {
      console.log('✅ TMDB API Key hợp lệ và sẵn sàng hoạt động.');
      tmdbAvailable = true;
    }
  } catch (err) {
    console.warn('⚠️ Không thể kết nối TMDB API -> Fallback Cinemeta:', err.message);
    tmdbAvailable = false;
  }
}

/**
 * Fetch with timeout & retry
 */
async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ITEM_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'aiometadata-franchise-crawler/1.0',
          'Accept': 'application/json',
          ...(options.headers || {})
        }
      });

      clearTimeout(timer);

      if (res.status === 429) {
        await sleep(1000);
        continue;
      }

      if (!res.ok) {
        return null;
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === maxRetries) return null;
      await sleep(300);
    }
  }
  return null;
}

function sanitizeItem(item) {
  let cleanType = item.type;
  if (cleanType === 'tv' || cleanType === 'series') {
    cleanType = 'series';
  } else {
    cleanType = 'movie';
  }

  let cleanId = item.imdbId || item.id;
  if (typeof cleanId === 'string' && /^(dc|marvel|sw)_tt\d+$/.test(cleanId)) {
    cleanId = cleanId.replace(/^(dc|marvel|sw)_/, '');
  }

  return {
    ...item,
    id: cleanId,
    type: cleanType
  };
}

/**
 * Enrich single item metadata using TMDB or Cinemeta
 */
async function enrichItem(rawItem) {
  const item = sanitizeItem(rawItem);

  // Nếu item đã có đầy đủ poster và id/year
  if (item.poster && item.title && (item.imdbId || item.tmdbId) && item.releaseYear) {
    return item;
  }

  try {
    let tmdbData = null;

    // 1. Tra cứu qua TMDb ID nếu TMDB khả dụng
    if (tmdbAvailable && item.tmdbId) {
      const endpoint = item.type === 'series' ? `/tv/${item.tmdbId}` : `/movie/${item.tmdbId}`;
      const url = `${TMDB_BASE_URL}${endpoint}?api_key=${tmdbApiKey}&language=en-US&append_to_response=external_ids`;
      tmdbData = await fetchWithRetry(url);
    }

    // 2. Tra cứu qua IMDb ID nếu TMDB khả dụng
    if (tmdbAvailable && !tmdbData && item.imdbId) {
      const url = `${TMDB_BASE_URL}/find/${item.imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id&language=en-US`;
      const findRes = await fetchWithRetry(url);
      if (findRes) {
        if (item.type === 'series' && findRes.tv_results && findRes.tv_results.length > 0) {
          tmdbData = findRes.tv_results[0];
        } else if (findRes.movie_results && findRes.movie_results.length > 0) {
          tmdbData = findRes.movie_results[0];
        }
      }
    }

    // 3. Fallback qua Cinemeta
    if (!tmdbData && item.imdbId) {
      const cinemetaType = item.type === 'series' ? 'series' : 'movie';
      const cinemetaRes = await fetchWithRetry(`${CINEMETA_BASE_URL}/${cinemetaType}/${item.imdbId}.json`);
      if (cinemetaRes && cinemetaRes.meta) {
        const meta = cinemetaRes.meta;
        return {
          ...item,
          title: item.title || meta.name,
          poster: item.poster || meta.poster,
          overview: item.overview || meta.description,
          releaseYear: item.releaseYear || (meta.year ? String(meta.year) : undefined),
          genres: item.genres || meta.genres
        };
      }
    }

    if (tmdbData) {
      const releaseDate = tmdbData.release_date || tmdbData.first_air_date || '';
      const year = releaseDate ? releaseDate.split('-')[0] : item.releaseYear;
      const posterPath = tmdbData.poster_path ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}` : item.poster;
      const imdbId = (tmdbData.external_ids && tmdbData.external_ids.imdb_id) || item.imdbId || (tmdbData.imdb_id || undefined);

      return {
        ...item,
        tmdbId: item.tmdbId || tmdbData.id,
        imdbId: imdbId,
        id: item.id || imdbId || `tmdb:${tmdbData.id}`,
        title: item.title || tmdbData.title || tmdbData.name,
        releaseYear: year,
        poster: posterPath,
        overview: item.overview || tmdbData.overview,
        genres: item.genres || (tmdbData.genres ? tmdbData.genres.map(g => ({ id: g.id, name: g.name })) : undefined)
      };
    }
    let cleanType = item.type;
    if (cleanType === 'tv' || cleanType === 'series') {
      cleanType = 'series';
    } else {
      cleanType = 'movie';
    }

    let cleanId = item.imdbId || item.id;
    if (typeof cleanId === 'string' && /^(dc|marvel|sw)_tt\d+$/.test(cleanId)) {
      cleanId = cleanId.replace(/^(dc|marvel|sw)_/, '');
    }

    return {
      ...item,
      id: cleanId,
      type: cleanType
    };
  } catch (err) {
    // Giữ nguyên item
  }

  let fallbackType = item.type === 'tv' || item.type === 'series' ? 'series' : 'movie';
  let fallbackId = item.imdbId || item.id;
  if (typeof fallbackId === 'string' && /^(dc|marvel|sw)_tt\d+$/.test(fallbackId)) {
    fallbackId = fallbackId.replace(/^(dc|marvel|sw)_/, '');
  }

  return {
    ...item,
    id: fallbackId,
    type: fallbackType
  };
}

/**
 * Xử lý mảng items với Concurrency Pool
 */
async function processItemsWithPool(items, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await enrichItem(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Fetch items from a TMDB Collection
 */
async function fetchTmdbCollection(collectionId) {
  if (!tmdbAvailable) return [];
  const url = `${TMDB_BASE_URL}/collection/${collectionId}?api_key=${tmdbApiKey}&language=en-US`;
  try {
    const data = await fetchWithRetry(url);
    if (data && Array.isArray(data.parts)) {
      const parts = data.parts.sort((a, b) => {
        const da = a.release_date || '9999';
        const db = b.release_date || '9999';
        return da.localeCompare(db);
      });

      return parts.map(m => ({
        tmdbId: m.id,
        id: `tmdb:${m.id}`,
        title: m.title,
        type: 'movie',
        releaseYear: m.release_date ? m.release_date.split('-')[0] : '',
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
        overview: m.overview || ''
      }));
    }
  } catch (err) {
    console.error(`  ❌ Lỗi khi lấy TMDB Collection ${collectionId}:`, err.message);
  }
  return [];
}

/**
 * Cập nhật đăng ký catalog-types.json, translations.json, franchiseCatalogs.json
 */
function updateRegistration() {
  console.log(`\n========================================`);
  console.log(`📝 Cập nhật catalog-types.json, translations.json & configure data`);
  console.log(`========================================`);

  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json') && f !== 'dc_Data.json');

  let catalogTypes = {};
  if (fs.existsSync(CATALOG_TYPES_PATH)) {
    catalogTypes = JSON.parse(fs.readFileSync(CATALOG_TYPES_PATH, 'utf8'));
  }
  catalogTypes.franchise = {};

  let translations = {};
  if (fs.existsSync(TRANSLATIONS_PATH)) {
    translations = JSON.parse(fs.readFileSync(TRANSLATIONS_PATH, 'utf8'));
  }

  const frontendCatalogs = [];

  files.forEach(file => {
    const id = file.replace('.json', '');
    const nameKey = `franchise_${id}`;

    catalogTypes.franchise[id] = {
      nameKey: nameKey,
      extraSupported: ["skip"]
    };

    const friendlyName = formatName(file);
    let prefix = "";
    if (file.startsWith('dc_')) prefix = "DC: ";
    if (file.startsWith('marvel_')) prefix = "Marvel: ";
    if (file.startsWith('star_wars_')) prefix = "Star Wars: ";

    if (!translations["en-US"]) translations["en-US"] = {};
    translations["en-US"][nameKey] = prefix + friendlyName;

    if (!translations["vi-VN"]) translations["vi-VN"] = {};
    translations["vi-VN"][nameKey] = prefix + friendlyName;

    let type = 'movie';
    if (file.toLowerCase().includes('series') || file.toLowerCase().includes('animation')) {
      type = 'series';
    }

    let franchise = 'marvel';
    if (file.startsWith('dc_')) franchise = 'dc';
    if (file.startsWith('star_wars_')) franchise = 'star_wars';

    frontendCatalogs.push({
      id: `franchise.${id}`,
      name: prefix + friendlyName,
      type: type,
      source: 'franchise',
      franchise: franchise
    });
  });

  fs.writeFileSync(CATALOG_TYPES_PATH, JSON.stringify(catalogTypes, null, 2));
  fs.writeFileSync(TRANSLATIONS_PATH, JSON.stringify(translations, null, 2));
  fs.writeFileSync(FRONTEND_CATALOGS_PATH, JSON.stringify(frontendCatalogs, null, 2));

  console.log(`✅ Đã đăng ký thành công ${frontendCatalogs.length} Franchise Catalogs!`);
}

/**
 * Main Crawler Runner
 */
async function runCrawler() {
  console.log('🚀 Bắt đầu quá trình cào và làm giàu dữ liệu Franchise Collections...');

  await verifyTmdbKey();

  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Không tìm thấy file manifest tại: ${MANIFEST_PATH}`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log(`📋 Đã tải manifest với ${manifest.catalogs.length} danh mục.`);

  for (let i = 0; i < manifest.catalogs.length; i++) {
    const cat = manifest.catalogs[i];
    console.log(`[${i + 1}/${manifest.catalogs.length}] 📦 Catalog: ${cat.id} (${cat.franchise}) - ${cat.items ? cat.items.length : 0} items`);

    let finalItems = [];

    if (cat.strategy === 'tmdb_collection' && cat.collectionId) {
      finalItems = await fetchTmdbCollection(cat.collectionId);
    } else if (Array.isArray(cat.items)) {
      finalItems = await processItemsWithPool(cat.items, CONCURRENCY);
    }

    if (finalItems.length > 0) {
      const outPath = path.join(OUT_DIR, `${cat.id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(finalItems, null, 2));
    }

    cat.itemCount = finalItems.length;
    cat.items = finalItems;
  }

  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  updateRegistration();

  console.log('\n🎉 Hoàn tất quá trình cào và làm giàu dữ liệu Franchise Collections!\n');
}

runCrawler().catch(err => {
  console.error('Fatal error during franchise crawler execution:', err);
  process.exit(1);
});
