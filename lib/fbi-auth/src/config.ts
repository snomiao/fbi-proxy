import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export type AllowlistRules = {
  emails?: string[];
  domains?: string[];
  anySignedIn?: boolean;
};

export type FirebaseConfig = {
  projectId: string;
  apiKey?: string;
  authDomain?: string;
};

export type LocalConfig = {
  email: string;
  name?: string;
};

export type AuthConfig = {
  version: 1;
  domain: string;
  cookieDomain: string;
  ssoHost: string;
  provider: "google" | "firebase" | "snolab" | "local";
  clientId?: string;
  clientSecret?: string;
  firebase?: FirebaseConfig;
  local?: LocalConfig;
  sessionSecret: string;
  allowlist: AllowlistRules;
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

export async function loadAuthConfig(
  path = defaultConfigPath(),
): Promise<AuthConfig> {
  if (!existsSync(path)) {
    throw new Error(
      `fbi-auth config not found at ${path}. Run 'bunx fbi-proxy --with-auth --reconfigure' to set up.`,
    );
  }
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AuthConfig;
  validate(parsed);
  return parsed;
}

export async function saveAuthConfig(
  cfg: AuthConfig,
  path = defaultConfigPath(),
): Promise<void> {
  validate(cfg);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
  await chmod(path, 0o600);
}

export function newSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function makeAuthConfig(input: {
  domain: string;
  provider: AuthConfig["provider"];
  clientId?: string;
  clientSecret?: string;
  firebase?: FirebaseConfig;
  local?: LocalConfig;
  allowlist?: AllowlistRules;
}): AuthConfig {
  const domain = stripLeadingDot(input.domain);
  return {
    version: 1,
    domain,
    cookieDomain: `.${domain}`,
    ssoHost: `sso.${domain}`,
    provider: input.provider,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    firebase: input.firebase,
    local: input.local,
    sessionSecret: newSessionSecret(),
    allowlist: input.allowlist ?? { anySignedIn: true },
  };
}

function stripLeadingDot(d: string): string {
  return d.startsWith(".") ? d.slice(1) : d;
}

function validate(c: AuthConfig): void {
  if (c.version !== 1)
    throw new Error(`Unsupported auth config version: ${c.version}`);
  if (!c.domain) throw new Error("auth config: 'domain' is required");
  if (!c.cookieDomain)
    throw new Error("auth config: 'cookieDomain' is required");
  if (!c.provider) throw new Error("auth config: 'provider' is required");

  if (c.provider === "google") {
    if (!c.clientId)
      throw new Error(
        "auth config: 'clientId' is required when provider is 'google'",
      );
  } else if (c.provider === "snolab") {
    // No clientId required — values come from snolabDefaults.ts. Domain
    // support and publication-state checks happen at server startup
    // (so the validator stays free of side-effects / imports).
  } else if (c.provider === "firebase") {
    if (!c.firebase?.projectId)
      throw new Error(
        "auth config: 'firebase.projectId' is required when provider is 'firebase'",
      );
  } else if (c.provider === "local") {
    if (!c.local?.email)
      throw new Error(
        "auth config: 'local.email' is required when provider is 'local'",
      );
  }

  if (!c.sessionSecret || c.sessionSecret.length < 32) {
    throw new Error("auth config: 'sessionSecret' must be at least 32 chars");
  }
}
