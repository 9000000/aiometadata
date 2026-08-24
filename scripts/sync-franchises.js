#!/usr/bin/env node
/**
 * sync-franchises.js
 * -------------------------------------------------------------------
 * Wrapper điều phối quá trình cào và đồng bộ Franchise Collections nội bộ.
 * Gọi trực tiếp scripts/crawl-franchises.js để làm giàu và sinh dữ liệu static.
 * -------------------------------------------------------------------
 */

const { fork } = require('child_process');
const path = require('path');

console.log('🚀 Khởi chạy Franchise Sync Engine...');

const crawlerScript = path.join(__dirname, 'crawl-franchises.js');
const child = fork(crawlerScript, process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('✅ Franchise Collections đã được đồng bộ và cập nhật thành công!');
    process.exit(0);
  } else {
    console.error(`❌ Đồng bộ thất bại với exit code: ${code}`);
    process.exit(code || 1);
  }
});
