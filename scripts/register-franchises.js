const fs = require('fs');
const path = require('path');

const franchisesDir = path.join(__dirname, '../addon/static/franchises');
const files = fs.readdirSync(franchisesDir).filter(f => f.endsWith('.json') && f !== 'dc_Data.json');

const catalogTypesPath = path.join(__dirname, '../addon/static/catalog-types.json');
const catalogTypes = JSON.parse(fs.readFileSync(catalogTypesPath, 'utf8'));

catalogTypes.franchise = {};

const translationsPath = path.join(__dirname, '../addon/static/translations.json');
const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf8'));

// Format a filename into a nice readable name
function formatName(name) {
  name = name.replace('.json', '');
  // Remove franchise prefix if exists e.g. dc_, marvel_, star_wars_
  name = name.replace(/^(dc|marvel|star_wars)_/, '');
  name = name.replace(/Data$/, '');
  // Insert space before capital letters
  name = name.replace(/([A-Z])/g, ' $1').trim();
  // Capitalize first letter
  name = name.charAt(0).toUpperCase() + name.slice(1);
  return name;
}

const frontendCatalogs = [];

files.forEach(file => {
  if (file === 'dc_Data.json') return; // Skip the massive combined one

  const id = file.replace('.json', ''); // e.g. dc_moviesData
  const nameKey = `franchise_${id}`;
  
  // Add to catalog-types
  catalogTypes.franchise[id] = {
    nameKey: nameKey,
    extraSupported: ["skip"]
  };

  // Add to translations (en-US)
  const friendlyName = formatName(file);
  
  let prefix = "";
  if (file.startsWith('dc_')) prefix = "DC: ";
  if (file.startsWith('marvel_')) prefix = "Marvel: ";
  if (file.startsWith('star_wars_')) prefix = "Star Wars: ";
  
  if (!translations["en-US"]) translations["en-US"] = {};
  translations["en-US"][nameKey] = prefix + friendlyName;
  
  if (!translations["vi-VN"]) translations["vi-VN"] = {};
  translations["vi-VN"][nameKey] = prefix + friendlyName; // Just use English for now

  // Prepare for frontend catalogs.ts
  let type = 'movie'; // Default to movie unless it has series or animations
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

console.log('Successfully updated catalog-types.json, translations.json and generated frontend data');
