import { existsSync } from "fs";
import { chmod } from "fs/promises";
import { getFbiProxyFilename } from "./getProxyFilename";
import { $ } from "./dSpawn";

if (import.meta.main) {
  await getFbiProxyBinary();
}

export async function getFbiProxyBinary({ rebuild = false } = {}) {
  const isWin = process.platform === "win32";
  const binaryName = getFbiProxyFilename();

  // Check for pre-built binary in Docker container
  const dockerBinary = "/app/bin/fbi-proxy";
  if (!rebuild && existsSync(dockerBinary)) {
    return dockerBinary;
  }

  const release = "./release/" + binaryName;
  const built = `./target/release/fbi-proxy${isWin ? ".exe" : ""}`;

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
  await $`cargo build --release`;
  if (existsSync(built)) {
    // Ensure the binary has execute permissions
    await chmod(built, 0o755).catch(() => {}); // Ignore errors if we can't change permissions
    return built;
  }

  throw new Error(
    "Oops, failed to build fbi-proxy binary. Please check your Rust setup.",
  );
}
