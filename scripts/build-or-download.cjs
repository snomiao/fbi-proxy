#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { downloadProxy, PROXY_BINARY_PATH } = require('./download-proxy.cjs');

function hasRust() {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildFromSource(isDev = false) {
  try {
    console.log('🔨 Building proxy from Rust source...');
    const buildCmd = isDev ? 'cargo build' : 'cargo build --release';
    const targetDir = isDev ? 'debug' : 'release';

    execSync(buildCmd, {
      cwd: path.join(__dirname, '..', 'rs'),
      stdio: 'inherit'
    });

    // Copy built binary to bin directory
    const binDir = path.join(__dirname, '..', 'bin');
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const sourceBinary = path.join(__dirname, '..', 'rs', 'target', targetDir,
      process.platform === 'win32' ? 'proxy.exe' : 'proxy');

    if (fs.existsSync(sourceBinary)) {
      fs.copyFileSync(sourceBinary, PROXY_BINARY_PATH);
      if (process.platform !== 'win32') {
        fs.chmodSync(PROXY_BINARY_PATH, '755');
      }
      console.log('✅ Proxy built and copied to bin/');
    }

    return true;
  } catch (error) {
    console.error('❌ Failed to build from source:', error.message);
    return false;
  }
}

async function buildOrDownload() {
  const isDev = process.argv.includes('--dev');

  // Check if binary already exists
  if (fs.existsSync(PROXY_BINARY_PATH)) {
    console.log('✅ Proxy binary already exists at', PROXY_BINARY_PATH);
    return;
  }

  // Strategy 1: Try building from source if Rust is available
  if (hasRust()) {
    console.log('🦀 Rust detected - building from source');
    if (buildFromSource(isDev)) {
      return;
    }
  }

  // Strategy 2: Download pre-built binary
  console.log('📦 Rust not available - downloading pre-built binary');
  try {
    await downloadProxy();
  } catch (error) {
    console.error('❌ All build strategies failed');
    console.log('');
    console.log('🛠️  Manual setup required:');
    console.log('1. Install Rust: https://rustup.rs/');
    console.log('2. Run: cd rs && cargo build --release');
    console.log('3. Copy rs/target/release/proxy(.exe) to bin/');
    process.exit(1);
  }
}

if (require.main === module) {
  buildOrDownload();
}

module.exports = { buildOrDownload };
