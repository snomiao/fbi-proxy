import {
  mkdir,
  writeFile,
  rm,
  chmod,
  rename,
  copyFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export type CaddyPlatform = {
  os: "linux" | "darwin" | "windows";
  arch: "amd64" | "arm64";
  ext: "tar.gz" | "zip";
};

export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CaddyPlatform {
  const osMap: Partial<Record<NodeJS.Platform, CaddyPlatform["os"]>> = {
    linux: "linux",
    darwin: "darwin",
    win32: "windows",
  };
  const archMap: Record<string, CaddyPlatform["arch"]> = {
    x64: "amd64",
    arm64: "arm64",
  };
  const os = osMap[platform];
  if (!os) throw new Error(`Unsupported OS: ${platform}`);
  const mappedArch = archMap[arch];
  if (!mappedArch) throw new Error(`Unsupported arch: ${arch}`);
  return { os, arch: mappedArch, ext: os === "windows" ? "zip" : "tar.gz" };
}

export function buildAssetName(version: string, p: CaddyPlatform): string {
  const v = version.replace(/^v/, "");
  return `caddy_${v}_${p.os}_${p.arch}.${p.ext}`;
}

export function buildAssetUrl(version: string, name: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/caddyserver/caddy/releases/download/${tag}/${name}`;
}

export function buildChecksumsUrl(version: string): string {
  const v = version.replace(/^v/, "");
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/caddyserver/caddy/releases/download/${tag}/caddy_${v}_checksums.txt`;
}

export async function fetchLatestVersion(
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    "https://api.github.com/repos/caddyserver/caddy/releases/latest",
    { signal, headers: { "User-Agent": "fbi-proxy" } },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for latest release`,
    );
  }
  const data = (await res.json()) as { tag_name?: string };
  if (!data.tag_name)
    throw new Error("GitHub API: response is missing tag_name");
  return data.tag_name;
}

/** Parse a checksums.txt file. Format: `<hex>  <filename>` per line. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([a-fA-F0-9]+)\s+\*?(.+)$/);
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

async function sha512OfPath(path: string): Promise<string> {
  const hash = createHash("sha512");
  const f = Bun.file(path);
  const stream = f.stream();
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export type DownloadOpts = {
  version?: string;
  destDir?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  platform?: CaddyPlatform;
};

/**
 * Download, verify (SHA-512 against the release's checksums.txt), extract,
 * and install a Caddy binary into `destDir` (default `~/.fbi-proxy/bin`).
 * Returns the absolute path to the extracted binary.
 *
 * Skips network work if the destination binary already exists.
 */
export async function downloadCaddy(opts: DownloadOpts = {}): Promise<string> {
  const log = opts.log ?? ((m) => console.log(`[caddy-download] ${m}`));
  const platform = opts.platform ?? detectPlatform();
  const destDir = opts.destDir ?? join(homedir(), ".fbi-proxy", "bin");
  const binaryName = platform.os === "windows" ? "caddy.exe" : "caddy";
  const destPath = join(destDir, binaryName);

  if (existsSync(destPath)) {
    log(`already installed: ${destPath}`);
    return destPath;
  }

  const version = opts.version ?? (await fetchLatestVersion(opts.signal));
  log(`platform: ${platform.os}/${platform.arch}, version: ${version}`);

  const assetName = buildAssetName(version, platform);
  const assetUrl = buildAssetUrl(version, assetName);
  const checksumsUrl = buildChecksumsUrl(version);

  log(`fetching checksums: ${checksumsUrl}`);
  const cksRes = await fetch(checksumsUrl, {
    signal: opts.signal,
    headers: { "User-Agent": "fbi-proxy" },
  });
  if (!cksRes.ok)
    throw new Error(
      `checksums fetch failed: ${cksRes.status} ${cksRes.statusText}`,
    );
  const checksums = parseChecksums(await cksRes.text());
  const expectedSum = checksums.get(assetName);
  if (!expectedSum) {
    throw new Error(
      `no checksum entry for '${assetName}' — release may not include this platform`,
    );
  }

  await mkdir(destDir, { recursive: true });
  const tmpArchive = join(tmpdir(), `fbi-proxy.${process.pid}.${assetName}`);

  log(`downloading: ${assetUrl}`);
  const dlRes = await fetch(assetUrl, {
    signal: opts.signal,
    headers: { "User-Agent": "fbi-proxy" },
  });
  if (!dlRes.ok)
    throw new Error(`download failed: ${dlRes.status} ${dlRes.statusText}`);
  const bytes = await dlRes.arrayBuffer();
  await writeFile(tmpArchive, Buffer.from(bytes));
  log(`downloaded ${bytes.byteLength} bytes`);

  const actualSum = await sha512OfPath(tmpArchive);
  if (actualSum !== expectedSum) {
    await rm(tmpArchive, { force: true });
    throw new Error(
      `SHA-512 mismatch for ${assetName}\n  expected: ${expectedSum}\n  got:      ${actualSum}`,
    );
  }
  log("checksum OK");

  const tmpExtract = join(tmpdir(), `fbi-proxy-extract.${process.pid}`);
  await rm(tmpExtract, { recursive: true, force: true });
  await mkdir(tmpExtract, { recursive: true });

  const tarCmd =
    platform.ext === "tar.gz"
      ? ["tar", "-xzf", tmpArchive, "-C", tmpExtract]
      : ["tar", "-xf", tmpArchive, "-C", tmpExtract];
  log(`extracting: ${tarCmd.join(" ")}`);
  const proc = Bun.spawn(tarCmd, { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    await rm(tmpArchive, { force: true });
    await rm(tmpExtract, { recursive: true, force: true });
    throw new Error(`tar extraction exited with code ${code}`);
  }

  const extractedBinary = join(tmpExtract, binaryName);
  if (!existsSync(extractedBinary)) {
    await rm(tmpArchive, { force: true });
    await rm(tmpExtract, { recursive: true, force: true });
    throw new Error(
      `archive did not contain expected '${binaryName}' at top level`,
    );
  }

  // Use copy+unlink instead of rename to handle cross-filesystem moves
  // (e.g. /tmp on tmpfs vs ~/.fbi-proxy on a different mount). rename(2)
  // fails with EXDEV in that case.
  try {
    await rename(extractedBinary, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      await copyFile(extractedBinary, destPath);
    } else {
      throw err;
    }
  }
  if (platform.os !== "windows") await chmod(destPath, 0o755);

  await rm(tmpArchive, { force: true });
  await rm(tmpExtract, { recursive: true, force: true });

  log(`installed: ${destPath}`);
  return destPath;
}
