#!/usr/bin/env node
/**
 * sync-franchises.js
 * -------------------------------------------------------------------
 * Tự động đồng bộ và chuyển đổi dữ liệu Franchise Collections từ 3 repo:
 * 1. Marvel:    https://github.com/9000000/addon-marvel (branch: main)
 * 2. DC:        https://github.com/tapframe/addon-dc (branch: main)
 * 3. Star Wars: https://github.com/9000000/addon-star-wars (branch: master)
 * 
 * Hỗ trợ cả 2 chế độ:
 * - Local filesystem (khi chạy trên máy dev)
 * - Remote GitHub raw fetch (khi chạy trên GitHub Actions / CI)
 * -------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const REPOS = [
  {
    name: 'dc',
    localPath: path.resolve(__dirname, '../../addon-dc/Data'),
    fallbackLocalPath: 'f:/MyGithub/addon-dc/Data',
    rawBaseUrl: 'https://raw.githubusercontent.com/tapframe/addon-dc/main/Data',
    apiUrl: 'https://api.github.com/repos/tapframe/addon-dc/contents/Data',
    files: [
      'DCEUMovies.js',
      'DCSeries.js',
      'animationsData.js',
      'chronologicalData.js',
      'everythingbatman.js',
      'everythingbatmananimation.js',
      'everythingsuperman.js',
      'everythingsupermananimation.js',
      'moviesData.js',
      'releaseData.js',
      'seriesData.js'
    ]
  },
  {
    name: 'marvel',
    localPath: path.resolve(__dirname, '../../addon-marvel/Data'),
    fallbackLocalPath: 'f:/MyGithub/addon-marvel/Data',
    rawBaseUrl: 'https://raw.githubusercontent.com/9000000/addon-marvel/main/Data',
    apiUrl: 'https://api.github.com/repos/9000000/addon-marvel/contents/Data',
    files: [
      'animationsData.js',
      'chronologicalData.js',
      'moviesData.js',
      'releaseData.js',
      'seriesData.js',
      'xmenData.js'
    ]
  },
  {
    name: 'star_wars',
    localPath: path.resolve(__dirname, '../../addon-star-wars/Data'),
    fallbackLocalPath: 'f:/MyGithub/addon-star-wars/Data',
    rawBaseUrl: 'https://raw.githubusercontent.com/9000000/addon-star-wars/master/Data',
    apiUrl: 'https://api.github.com/repos/9000000/addon-star-wars/contents/Data',
    files: [
      'animatedSeriesData.js',
      'anthologyFilmsData.js',
      'bountyHuntersUnderworldData.js',
      'droidsCreaturesData.js',
      'empireEraData.js',
      'highRepublicEraData.js',
      'jediSithLoreData.js',
      'liveActionSeriesData.js',
      'microSeriesShortsData.js',
      'moviesSeriesChronologicalData.js',
      'moviesSeriesReleaseData.js',
      'newRepublicEraData.js',
      'skywalkerSagaData.js'
    ]
  }
];

const outDir = path.join(__dirname, '../addon/static/franchises');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Format a filename into a nice readable name
function formatName(name) {
  name = name.replace('.json', '');
  name = name.replace(/^(dc|marvel|star_wars)_/, '');
  name = name.replace(/Data$/, '');
  name = name.replace(/([A-Z])/g, ' $1').trim();
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name;
}

function parseJsContent(content) {
  // Remove module.exports = or export default
  const cleaned = content
    .replace(/module\.exports\s*=\s*/, '')
    .replace(/export\s+default\s*/, '')
    .replace(/;\s*$/, '')
    .trim();

  // Use Function to evaluate cleanly
  const getObj = new Function(`return ${cleaned}`);
  return getObj();
}

async function fetchRemoteFile(url) {
  const headers = {
    'User-Agent': 'aiometadata-franchise-sync',
    'Accept': 'text/plain, application/json, */*'
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

async function syncFranchise(repo) {
  console.log(`\n========================================`);
  console.log(`📦 Đồng bộ franchise: [${repo.name.toUpperCase()}]`);
  console.log(`========================================`);

  const hasLocal = fs.existsSync(repo.localPath) || fs.existsSync(repo.fallbackLocalPath);
  const localDir = fs.existsSync(repo.localPath) ? repo.localPath : repo.fallbackLocalPath;

  for (const fileName of repo.files) {
    let content = null;
    const outName = `${repo.name}_${fileName.replace('.js', '.json')}`;
    const outPath = path.join(outDir, outName);

    try {
      if (hasLocal && fs.existsSync(path.join(localDir, fileName))) {
        content = fs.readFileSync(path.join(localDir, fileName), 'utf8');
        console.log(`  [LOCAL] Đọc file ${fileName}`);
      } else {
        const remoteUrl = `${repo.rawBaseUrl}/${fileName}`;
        console.log(`  [REMOTE] Fetching ${remoteUrl}...`);
        content = await fetchRemoteFile(remoteUrl);
      }

      if (content) {
        let parsed = null;
        if (fileName.endsWith('.json')) {
          parsed = JSON.parse(content);
        } else {
          parsed = parseJsContent(content);
        }

        if (Array.isArray(parsed)) {
          fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
          console.log(`  ✅ Đã lưu: ${outName} (${parsed.length} items)`);
        }
      }
    } catch (err) {
      console.error(`  ❌ Lỗi khi xử lý file ${fileName}:`, err.message);
    }
  }
}

function updateRegistration() {
  console.log(`\n========================================`);
  console.log(`📝 Cập nhật catalog-types.json & translations.json`);
  console.log(`========================================`);

  const files = fs.readdirSync(outDir).filter(f => f.endsWith('.json') && f !== 'dc_Data.json');

  const catalogTypesPath = path.join(__dirname, '../addon/static/catalog-types.json');
  const catalogTypes = JSON.parse(fs.readFileSync(catalogTypesPath, 'utf8'));
  catalogTypes.franchise = {};

  const translationsPath = path.join(__dirname, '../addon/static/translations.json');
  const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf8'));

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

  fs.writeFileSync(catalogTypesPath, JSON.stringify(catalogTypes, null, 2));
  fs.writeFileSync(translationsPath, JSON.stringify(translations, null, 2));
  fs.writeFileSync(path.join(__dirname, '../configure/src/data/franchiseCatalogs.json'), JSON.stringify(frontendCatalogs, null, 2));

  console.log(`✅ Đã đăng ký thành công ${frontendCatalogs.length} Franchise Catalogs!`);
}

async function main() {
  console.log('🚀 Bắt đầu quá trình đồng bộ Franchise Collections...');
  for (const repo of REPOS) {
    await syncFranchise(repo);
  }
  updateRegistration();
  console.log('\n🎉 Hoàn tất quá trình đồng bộ Franchise Collections!\n');
}

main().catch(err => {
  console.error('Fatal error during franchise sync:', err);
  process.exit(1);
});
