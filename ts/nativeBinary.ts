// The native binary that the package manager installed for this machine.
//
// Each platform's build is published as its own package
// (`fbi-proxy-<os>-<arch>`, an alias of `fbi-proxy@<version>-<os>-<arch>`) and
// listed as an optional dependency, so an install downloads one binary instead
// of all of them. Packed by https://github.com/snomiao/rustify
// (templates/npm/native-binary.mjs).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Absolute path of `binary` from the platform package of `packageName`, or
 * null when there is none: optional dependencies were skipped, there is no
 * build for this platform, or this is a checkout rather than an install.
 */
export function nativeBinary(
  packageName: string,
  binary: string,
  from: string,
): string | null {
  const os = process.platform === "android" ? "linux" : process.platform;
  const key = `${os}-${process.arch}`;
  try {
    const manifest = createRequire(from).resolve(
      `${packageName}-${key}/package.json`,
    );
    const file = path.join(
      path.dirname(manifest),
      "bin",
      binary + (process.platform === "win32" ? ".exe" : ""),
    );
    return existsSync(file) ? file : null;
  } catch {
    return null;
  }
}
