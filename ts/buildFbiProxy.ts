import fsp from "fs/promises";
import { existsSync } from "fs";
import { getProxyFilename } from "./getProxyFilename";
import { copyFile } from "fs/promises";
import { $ } from "./dSpawn";
import { mkdir } from "fs/promises";

if (import.meta.main) {
  await buildFbiProxy();
}

export async function buildFbiProxy({ rebuild = false } = {}) {
  const isWin = process.platform === "win32";
  const binaryName = getProxyFilename();

  // Check for pre-built binary in Docker container
  const dockerBinary = "/app/bin/fbi-proxy";
  if (!rebuild && existsSync(dockerBinary)) {
    return dockerBinary;
  }

  const release = "./release/" + binaryName;
  const built = `./target/release/fbi-proxy${isWin ? ".exe" : ""}`;

  // return built if exists
  if (!rebuild && existsSync(built)) {
    return built;
  }

  // return release if exists
  if (!rebuild && existsSync(release)) return release;

  // build and return built target
  await $`cargo build --release`;
  if (existsSync(built)) return built;

  throw new Error(
    "Oops, failed to build fbi-proxy binary. Please check your Rust setup.",
  );
}
