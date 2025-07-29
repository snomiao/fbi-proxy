export function getProxyFilename() {
    return {
        "darwin-arm64": "fbi-proxy-darwin",
        "darwin-x64": "fbi-proxy-darwin",
        "linux-arm64": "fbi-proxy-linux-arm64",
        "linux-x64": "fbi-proxy-linux-x64",
        "linux-x86_64": "fbi-proxy-linux-x64",
        "win32-arm64": "fbi-proxy-windows-arm64.exe",
        "win32-x64": "fbi-proxy-windows-x64.exe",
    }[process.platform + "-" + process.arch] || "fbi-proxy-linux-x64";
}
