@echo off
echo Installing required dependencies for Windows build...

echo.
echo Checking for required tools...

where cmake >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ CMake not found. Installing via chocolatey...
    where choco >nul 2>&1
    if %errorlevel% neq 0 (
        echo Please install Chocolatey first: https://chocolatey.org/install
        echo Or install CMake manually: https://cmake.org/download/
        pause
        exit /b 1
    )
    choco install cmake -y
) else (
    echo ✅ CMake found
)

where perl >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Perl not found. Installing Strawberry Perl...
    where choco >nul 2>&1
    if %errorlevel% neq 0 (
        echo Please install Chocolatey first or install Strawberry Perl manually
        echo Strawberry Perl: https://strawberryperl.com/
        pause
        exit /b 1
    )
    choco install strawberryperl -y
) else (
    echo ✅ Perl found
)

echo.
echo Setting environment variables for Windows build...
set OPENSSL_NO_VENDOR=1
set CMAKE_GENERATOR=Visual Studio 17 2022

echo.
echo Building Rust proxy with Pingora...
cargo build --release

if %errorlevel% equ 0 (
    echo.
    echo ✅ Build successful!
    echo Binary location: target\release\proxy.exe
) else (
    echo.
    echo ❌ Build failed. Check the error messages above.
    echo.
    echo Common solutions:
    echo 1. Restart your terminal after installing dependencies
    echo 2. Make sure Visual Studio Build Tools are installed
    echo 3. Try: cargo clean && cargo build --release
)

pause
