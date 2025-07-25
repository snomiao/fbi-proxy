#!/bin/bash

# Build script for the Rust proxy
echo "Building Rust proxy..."

cd rs
cargo build --release

if [ $? -eq 0 ]; then
    echo "✅ Rust proxy built successfully"
    echo "Binary location: rs/target/release/proxy"
else
    echo "❌ Failed to build Rust proxy"
    exit 1
fi
