@echo off

REM Build script for the Rust proxy
echo Building Rust proxy...

cd rs
cargo build --release

if %errorlevel% equ 0 (
    echo ✅ Rust proxy built successfully
    echo Binary location: rs\target\release\proxy.exe
) else (
    echo ❌ Failed to build Rust proxy
    exit /b 1
)
