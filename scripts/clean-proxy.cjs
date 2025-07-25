#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function cleanProxy() {
  const binDir = path.join(__dirname, '..', 'bin');
  const rsTargetDir = path.join(__dirname, '..', 'rs', 'target');
  
  // Clean bin directory
  if (fs.existsSync(binDir)) {
    fs.rmSync(binDir, { recursive: true, force: true });
    console.log('✅ Cleaned bin/ directory');
  }
  
  // Clean Rust target directory if it exists
  if (fs.existsSync(rsTargetDir)) {
    fs.rmSync(rsTargetDir, { recursive: true, force: true });
    console.log('✅ Cleaned rs/target/ directory');
  }
  
  console.log('🧹 Proxy cleanup completed');
}

if (require.main === module) {
  cleanProxy();
}

module.exports = { cleanProxy };
