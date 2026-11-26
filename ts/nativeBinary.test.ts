import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { nativeBinary } from "./nativeBinary";

const os = process.platform === "android" ? "linux" : process.platform;
const key = `${os}-${process.arch}`;
const exe = process.platform === "win32" ? ".exe" : "";
let dir: string | undefined;

// An install as a package manager lays it out: the package, and beside it the
// platform package for this machine.
function install(withBinary: boolean): string {
  dir = mkdtempSync(path.join(tmpdir(), "fbi-native-"));
  const pkg = path.join(dir, "node_modules", "demo");
  const platform = path.join(dir, "node_modules", `demo-${key}`);
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  mkdirSync(path.join(platform, "bin"), { recursive: true });
  writeFileSync(path.join(platform, "package.json"), "{}");
  if (withBinary) writeFileSync(path.join(platform, "bin", `tool${exe}`), "");
  return pathToFileURL(path.join(pkg, "dist", "cli.js")).href;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("nativeBinary", () => {
  it("finds the binary in the platform package installed beside the package", () => {
    const from = install(true);
    expect(nativeBinary("demo", "tool", from)).toBe(
      path.join(dir!, "node_modules", `demo-${key}`, "bin", `tool${exe}`),
    );
  });

  it("is null when the platform package has no such binary", () => {
    expect(nativeBinary("demo", "tool", install(false))).toBeNull();
  });

  it("is null when there is no platform package at all", () => {
    expect(nativeBinary("no-such-package", "tool", install(true))).toBeNull();
  });
});
