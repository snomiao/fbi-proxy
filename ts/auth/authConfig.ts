import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export type FirebaseSubConfig = {
  projectId: string;
  apiKey?: string;
  authDomain?: string;
};

export type AuthConfigShape = {
  version: 1;
  domain: string;
  cookieDomain: string;
  ssoHost: string;
  provider: "google" | "firebase" | "snolab";
  clientId?: string;
  clientSecret?: string;
  firebase?: FirebaseSubConfig;
  sessionSecret: string;
  allowlist: {
    emails?: string[];
    domains?: string[];
    anySignedIn?: boolean;
  };
};

export function defaultConfigPath(): string {
  return (
    process.env.FBI_AUTH_CONFIG_PATH ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "fbi-proxy",
      "auth.json",
    )
  );
}

export async function readConfigOrNull(
  path = defaultConfigPath(),
): Promise<AuthConfigShape | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as AuthConfigShape;
  } catch {
    return null;
  }
}

export async function writeConfig(
  cfg: AuthConfigShape,
  path = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
  await chmod(path, 0o600);
}

export function configFromEnv(domain: string): AuthConfigShape | null {
  const provider =
    (process.env.FBI_AUTH_PROVIDER as AuthConfigShape["provider"]) ?? "google";
  const clientId = process.env.FBI_AUTH_CLIENT_ID;
  const firebaseProjectId = process.env.FBI_AUTH_FIREBASE_PROJECT_ID;

  if (provider === "firebase") {
    if (!firebaseProjectId) return null;
  } else {
    if (!clientId) return null;
  }

  const d = domain.startsWith(".") ? domain.slice(1) : domain;
  return {
    version: 1,
    domain: d,
    cookieDomain: `.${d}`,
    ssoHost: `sso.${d}`,
    provider,
    clientId,
    clientSecret: process.env.FBI_AUTH_CLIENT_SECRET,
    firebase: firebaseProjectId
      ? {
          projectId: firebaseProjectId,
          apiKey: process.env.FBI_AUTH_FIREBASE_API_KEY,
          authDomain: process.env.FBI_AUTH_FIREBASE_AUTH_DOMAIN,
        }
      : undefined,
    sessionSecret:
      process.env.FBI_AUTH_SESSION_SECRET ??
      randomBytes(32).toString("base64url"),
    allowlist: parseAllowlistEnv(),
  };
}

function parseAllowlistEnv(): AuthConfigShape["allowlist"] {
  const emails = process.env.FBI_AUTH_ALLOW_EMAILS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const domains = process.env.FBI_AUTH_ALLOW_DOMAINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const anySignedIn = process.env.FBI_AUTH_ALLOW_ANY === "true";
  if (!emails?.length && !domains?.length && !anySignedIn) {
    return { anySignedIn: true };
  }
  return { emails, domains, anySignedIn };
}

export function helpfulSetupMessage(domain: string, path: string): string {
  return [
    "",
    "fbi-auth requires a config file but none was found.",
    `Expected at: ${path}`,
    "",
    "Quick setup (Phase 1 — manual; setup wizard arrives in Phase 2):",
    "",
    "  1. Create a Google OAuth Web client at https://console.cloud.google.com/apis/credentials",
    `     - Authorized redirect URI: https://sso.${domain}/callback`,
    `     - Authorized JS origin:    https://sso.${domain}`,
    "",
    "  2. Either write the config file directly:",
    `     mkdir -p $(dirname ${path}) && cat > ${path} <<EOF`,
    "     {",
    '       "version": 1,',
    `       "domain": "${domain}",`,
    `       "cookieDomain": ".${domain}",`,
    `       "ssoHost": "sso.${domain}",`,
    '       "provider": "google",',
    '       "clientId": "<your-client-id>",',
    '       "clientSecret": "<your-client-secret>",',
    '       "sessionSecret": "<32+ random chars, base64url preferred>",',
    '       "allowlist": { "anySignedIn": true }',
    "     }",
    "     EOF",
    "",
    "  3. Or use env vars (auto-creates the config on first run):",
    `     FBI_AUTH_CLIENT_ID=...  FBI_AUTH_CLIENT_SECRET=...  bunx fbi-proxy --with-auth --domain ${domain}`,
    "",
  ].join("\n");
}
