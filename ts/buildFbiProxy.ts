import { existsSync } from "fs";
import { chmod } from "fs/promises";
import path from "path";
import { getFbiProxyFilename } from "./getProxyFilename";
import { nativeBinary } from "./nativeBinary";
import { $ } from "./dSpawn";

if (import.meta.main) {
  await getFbiProxyBinary();
}

export async function getFbiProxyBinary({
  rebuild = false,
  originalCwd = "",
} = {}) {
  const isWin = process.platform === "win32";
  const binaryName = getFbiProxyFilename();
  const binarySuffix = isWin ? ".exe" : "";

  // Check for local build in original working directory first
  // This allows users to run `bunx fbi-proxy` from their local repo and use their own build
  if (!rebuild && originalCwd) {
    const localBuilt = path.join(
      originalCwd,
      `target/release/fbi-proxy${binarySuffix}`,
    );
    if (existsSync(localBuilt)) {
      console.log(`Using local build: ${localBuilt}`);
      await chmod(localBuilt, 0o755).catch(() => {});
      return localBuilt;
    }
  }

  // Check for pre-built binary in Docker container
  const dockerBinary = "/app/bin/fbi-proxy";
  if (!rebuild && existsSync(dockerBinary)) {
    return dockerBinary;
  }

  // Installed from npm with the binary for this machine in its own platform
  // package (fbi-proxy-<os>-<arch>). Absent in a checkout and in releases that
  // still bundle every binary under ./release, where the lookups below apply.
  const packaged = rebuild
    ? null
    : nativeBinary("fbi-proxy", "fbi-proxy", import.meta.url);
  if (packaged) {
    await chmod(packaged, 0o755).catch(() => {});
    return packaged;
  }

  const release = "./release/" + binaryName;
  const built = `./target/release/fbi-proxy${binarySuffix}`;

  // return built if exists
  if (!rebuild && existsSync(built)) {
    // Ensure the binary has execute permissions
    await chmod(built, 0o755).catch(() => {}); // Ignore errors if we can't change permissions
    return built;
  }

  // return release if exists
  if (!rebuild && existsSync(release)) {
    // Ensure the binary has execute permissions
    await chmod(release, 0o755).catch(() => {}); // Ignore errors if we can't change permissions
    return release;
  }

  // build and return built target
  await $`cargo build --release --bin fbi-proxy`;
  if (existsSync(built)) {
    // Ensure the binary has execute permissions
    await chmod(built, 0o755).catch(() => {}); // Ignore errors if we can't change permissions
    return built;
  }

  throw new Error(
    "Oops, failed to build fbi-proxy binary. Please check your Rust setup.",
  );
}
