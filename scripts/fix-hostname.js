const fs = require('fs');
const path = require('path');

function walkSync(dir, filelist = []) {
    fs.readdirSync(dir).forEach(file => {
        const filepath = path.join(dir, file);
        if (fs.statSync(filepath).isDirectory()) {
            walkSync(filepath, filelist);
        } else if (/\.(js|ts|jsx|tsx)$/.test(file)) {
            filelist.push(filepath);
        }
    });
    return filelist;
}

function fixHostnameChecks(dir) {
    const files = walkSync(dir);
    let changed = 0;
    
    for (const file of files) {
        let content = fs.readFileSync(file, 'utf8');
        
        // Find: process.env.HOST_NAME.startsWith
        // Exclude cases that already have safe checks like process.env.HOST_NAME && process.env.HOST_NAME.startsWith
        
        const original = content;
        content = content.replace(/(?<!\&\&\s*)process\.env\.HOST_NAME\.startsWith/g, "process.env.HOST_NAME?.startsWith");
        
        if (content !== original) {
            fs.writeFileSync(file, content);
            console.log(`Fixed ${file}`);
            changed++;
        }
    }
    console.log(`Fixed ${changed} files.`);
}

fixHostnameChecks(path.join(__dirname, '../addon'));
