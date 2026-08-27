const fs = require('fs');
const path = require('path');

const franchises = [
  { name: 'dc', path: 'f:/MyGithub/addon-dc/Data' },
  { name: 'marvel', path: 'f:/MyGithub/addon-marvel/Data' },
  { name: 'star_wars', path: 'f:/MyGithub/addon-star-wars/Data' }
];

const outDir = path.join(__dirname, '../addon/static/franchises');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

franchises.forEach(franchise => {
  if (fs.existsSync(franchise.path)) {
    const files = fs.readdirSync(franchise.path).filter(f => f.endsWith('.js') || f.endsWith('.json'));
    
    files.forEach(file => {
      const filePath = path.join(franchise.path, file);
      const content = fs.readFileSync(filePath, 'utf8');
      
      let jsonStr;
      try {
        if (file.endsWith('.json')) {
          jsonStr = content;
        } else {
          // Remove module.exports = or export default
          const cleaned = content
            .replace(/module\.exports\s*=\s*/, '')
            .replace(/export\s+default\s*/, '')
            .replace(/;\s*$/, '');
          
          // Use Function to evaluate the string safely to an object
          const getObj = new Function(`return ${cleaned}`);
          const obj = getObj();
          
          jsonStr = JSON.stringify(obj, null, 2);
        }
        
        const outName = `${franchise.name}_${file.replace('.js', '.json')}`;
        fs.writeFileSync(path.join(outDir, outName), jsonStr);
        console.log(`Converted: ${outName}`);
      } catch (err) {
        console.error(`Failed to convert ${file} in ${franchise.name}:`, err.message);
      }
    });
  } else {
    console.warn(`Directory not found: ${franchise.path}`);
  }
});
