#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const PROXY_BINARY_DIR = path.join(__dirname, '..', 'bin');
const PROXY_BINARY_PATH = path.join(PROXY_BINARY_DIR, process.platform === 'win32' ? 'proxy.exe' : 'proxy');

// GitHub releases URL (update this when you publish releases)
const GITHUB_REPO = 'snomiao/fbi-proxy'; // Update this
const RELEASE_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download`;

function getPlatformBinary() {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'win32') {
    return 'proxy-windows-x64.exe';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'proxy-macos-arm64' : 'proxy-macos-x64';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'proxy-linux-arm64' : 'proxy-linux-x64';
  }
  
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url}...`);
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      
      file.on('finish', () => {
        file.close();
        // Make executable on Unix-like systems
        if (process.platform !== 'win32') {
          fs.chmodSync(dest, '755');
        }
        console.log('✅ Download completed!');
        resolve();
      });
    }).on('error', reject);
  });
}

async function downloadProxy() {
  try {
    // Check if binary already exists
    if (fs.existsSync(PROXY_BINARY_PATH)) {
      console.log('✅ Proxy binary already exists');
      return;
    }

    // Create bin directory if it doesn't exist
    if (!fs.existsSync(PROXY_BINARY_DIR)) {
      fs.mkdirSync(PROXY_BINARY_DIR, { recursive: true });
    }

    const binaryName = getPlatformBinary();
    const downloadUrl = `${RELEASE_URL}/${binaryName}`;
    
    await downloadFile(downloadUrl, PROXY_BINARY_PATH);
    console.log(`✅ Proxy binary downloaded to ${PROXY_BINARY_PATH}`);
    
  } catch (error) {
    console.error('❌ Failed to download proxy binary:', error.message);
    console.log('');
    console.log('📦 Fallback options:');
    console.log('1. Install Rust and build from source:');
    console.log('   curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh');
    console.log('   cd rs && cargo build --release');
    console.log('');
    console.log('2. Download manually from GitHub releases');
    console.log('3. Use Docker: docker pull your-username/fbi-proxy');
    
    // Don't exit with error - allow installation to continue
    process.exit(0);
  }
}

if (require.main === module) {
  downloadProxy();
}

module.exports = { downloadProxy, PROXY_BINARY_PATH };
