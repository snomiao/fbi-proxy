import { describe, it, expect } from "vitest";
import {
  detectPlatform,
  buildAssetName,
  buildAssetUrl,
  buildChecksumsUrl,
  parseChecksums,
} from "./downloadCaddy";

describe("detectPlatform", () => {
  it("maps linux/x64 → linux/amd64/tar.gz", () => {
    expect(detectPlatform("linux", "x64")).toEqual({
      os: "linux",
      arch: "amd64",
      ext: "tar.gz",
    });
  });

  it("maps linux/arm64 → linux/arm64/tar.gz", () => {
    expect(detectPlatform("linux", "arm64")).toEqual({
      os: "linux",
      arch: "arm64",
      ext: "tar.gz",
    });
  });

  it("maps darwin/arm64 → darwin/arm64/tar.gz (Apple Silicon)", () => {
    expect(detectPlatform("darwin", "arm64")).toEqual({
      os: "darwin",
      arch: "arm64",
      ext: "tar.gz",
    });
  });

  it("maps win32/x64 → windows/amd64/zip", () => {
    expect(detectPlatform("win32", "x64")).toEqual({
      os: "windows",
      arch: "amd64",
      ext: "zip",
    });
  });

  it("throws on unsupported OS", () => {
    expect(() => detectPlatform("freebsd" as NodeJS.Platform, "x64")).toThrow(
      /Unsupported OS/,
    );
  });

  it("throws on unsupported arch", () => {
    expect(() => detectPlatform("linux", "mips")).toThrow(/Unsupported arch/);
  });
});

describe("buildAssetName", () => {
  it("matches Caddy's release naming for linux amd64", () => {
    expect(
      buildAssetName("v2.11.3", { os: "linux", arch: "amd64", ext: "tar.gz" }),
    ).toBe("caddy_2.11.3_linux_amd64.tar.gz");
  });

  it("accepts a version without the v prefix", () => {
    expect(
      buildAssetName("2.11.3", { os: "darwin", arch: "arm64", ext: "tar.gz" }),
    ).toBe("caddy_2.11.3_darwin_arm64.tar.gz");
  });

  it("uses .zip for windows", () => {
    expect(
      buildAssetName("v2.11.3", { os: "windows", arch: "amd64", ext: "zip" }),
    ).toBe("caddy_2.11.3_windows_amd64.zip");
  });
});

describe("buildAssetUrl", () => {
  it("points at the GitHub Releases asset CDN with the v-prefixed tag", () => {
    expect(buildAssetUrl("v2.11.3", "caddy_2.11.3_linux_amd64.tar.gz")).toBe(
      "https://github.com/caddyserver/caddy/releases/download/v2.11.3/caddy_2.11.3_linux_amd64.tar.gz",
    );
  });

  it("normalizes a bare version into a v-tag", () => {
    expect(buildAssetUrl("2.11.3", "caddy_2.11.3_linux_amd64.tar.gz")).toBe(
      "https://github.com/caddyserver/caddy/releases/download/v2.11.3/caddy_2.11.3_linux_amd64.tar.gz",
    );
  });
});

describe("buildChecksumsUrl", () => {
  it("uses the `caddy_<v>_checksums.txt` naming Caddy ships", () => {
    expect(buildChecksumsUrl("v2.11.3")).toBe(
      "https://github.com/caddyserver/caddy/releases/download/v2.11.3/caddy_2.11.3_checksums.txt",
    );
  });
});

describe("parseChecksums", () => {
  it("parses the real Caddy checksums.txt shape", () => {
    const fixture = [
      "abc123  caddy_2.11.3_buildable-artifact.tar.gz",
      "def456  caddy_2.11.3_linux_amd64.tar.gz",
      "0123456789abcdef  caddy_2.11.3_darwin_arm64.tar.gz",
    ].join("\n");
    const map = parseChecksums(fixture);
    expect(map.size).toBe(3);
    expect(map.get("caddy_2.11.3_linux_amd64.tar.gz")).toBe("def456");
    expect(map.get("caddy_2.11.3_darwin_arm64.tar.gz")).toBe(
      "0123456789abcdef",
    );
  });

  it("skips blank lines and comments", () => {
    const map = parseChecksums(`
# this is a comment

abc  some.tar.gz

`);
    expect(map.size).toBe(1);
    expect(map.get("some.tar.gz")).toBe("abc");
  });

  it("normalizes hex to lowercase", () => {
    const map = parseChecksums("ABCDEF  file.tar.gz");
    expect(map.get("file.tar.gz")).toBe("abcdef");
  });

  it("tolerates the BSD '*filename' marker", () => {
    const map = parseChecksums("abc  *file.tar.gz");
    expect(map.get("file.tar.gz")).toBe("abc");
  });
});
