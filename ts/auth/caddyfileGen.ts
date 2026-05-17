import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";

export type CaddyfileOpts = {
  /** Apex domain (e.g. "example.dev"). A leading "." is stripped. */
  domain: string;
  /** SSO host (e.g. "sso.example.dev"). Only used when `withAuth` is true. */
  ssoHost?: string;
  /** Local port that fbi-auth listens on. Required when `withAuth` is true. */
  fbiAuthPort?: number;
  /** Local port that fbi-proxy (Rust) listens on. */
  fbiProxyPort: number;
  /** Optional Let's Encrypt account email — emits a global `{ email ... }` block. */
  acmeEmail?: string;
  /**
   * TLS strategy:
   *  - "auto" (default): empty stanza — Caddy chooses ACME via Let's Encrypt.
   *  - "internal": use Caddy's local CA (`tls internal`). Useful for `.fbi.com` etc.
   */
  tlsMode?: "auto" | "internal";
  /**
   * When true, wires the `forward_auth` directive through to fbi-auth and
   * exposes `<ssoHost>` as its own site. When false, only the wildcard
   * `*.<domain>` site is emitted (plain reverse_proxy to fbi-proxy).
   */
  withAuth?: boolean;
};

/**
 * Generate a Caddyfile suitable for `bunx fbi-proxy --with-caddy [--with-auth]`.
 *
 * The shape (when `withAuth=true`):
 *
 * ```caddyfile
 * {
 *   email <acmeEmail>
 * }
 *
 * <ssoHost> {
 *   reverse_proxy 127.0.0.1:<fbiAuthPort>
 *   <tls-stanza>
 * }
 *
 * *.<domain> {
 *   @notauth not path /api/auth/* /login /callback /logout
 *   forward_auth @notauth 127.0.0.1:<fbiAuthPort> {
 *     uri /api/auth/verify
 *     copy_headers Remote-User Remote-Email Remote-Name
 *     header_up X-Forwarded-Host {host}
 *     header_up X-Forwarded-Uri {uri}
 *   }
 *   reverse_proxy 127.0.0.1:<fbiProxyPort>
 *   <tls-stanza>
 * }
 * ```
 *
 * When `withAuth=false`, only the `*.<domain>` block is emitted and it skips
 * the `forward_auth` directive — i.e. plain TLS termination + reverse proxy.
 */
export function generateCaddyfile(opts: CaddyfileOpts): string {
  const domain = stripLeadingDot(opts.domain);
  const tlsMode = opts.tlsMode ?? "auto";
  const withAuth = opts.withAuth ?? false;
  const tlsStanza = tlsMode === "internal" ? "  tls internal\n" : "";

  const sections: string[] = [];

  if (opts.acmeEmail && opts.acmeEmail.trim() !== "") {
    sections.push(`{\n  email ${opts.acmeEmail.trim()}\n}`);
  }

  if (withAuth) {
    const ssoHost = opts.ssoHost ?? `sso.${domain}`;
    const fbiAuthPort = opts.fbiAuthPort;
    if (fbiAuthPort === undefined) {
      throw new Error(
        "generateCaddyfile: fbiAuthPort is required when withAuth is true",
      );
    }
    sections.push(
      `${ssoHost} {\n` +
        `  reverse_proxy 127.0.0.1:${fbiAuthPort}\n` +
        tlsStanza +
        `}`,
    );

    sections.push(
      `*.${domain} {\n` +
        `  @notauth not path /api/auth/* /login /callback /logout\n` +
        `  forward_auth @notauth 127.0.0.1:${fbiAuthPort} {\n` +
        `    uri /api/auth/verify\n` +
        `    copy_headers Remote-User Remote-Email Remote-Name\n` +
        `    header_up X-Forwarded-Host {host}\n` +
        `    header_up X-Forwarded-Uri {uri}\n` +
        `  }\n` +
        `  reverse_proxy 127.0.0.1:${opts.fbiProxyPort}\n` +
        tlsStanza +
        `}`,
    );
  } else {
    sections.push(
      `*.${domain} {\n` +
        `  reverse_proxy 127.0.0.1:${opts.fbiProxyPort}\n` +
        tlsStanza +
        `}`,
    );
  }

  return sections.join("\n\n") + "\n";
}

export function defaultCaddyfilePath(): string {
  return (
    process.env.FBI_PROXY_CADDYFILE_PATH ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "fbi-proxy",
      "Caddyfile",
    )
  );
}

/**
 * Render and write the Caddyfile to disk. Returns the rendered string and the
 * absolute path it was written to. Creates parent directories as needed and
 * chmods the file to 0644 (it's not a secret).
 */
export async function writeCaddyfile(
  opts: CaddyfileOpts,
  path = defaultCaddyfilePath(),
): Promise<{ content: string; path: string }> {
  const content = generateCaddyfile(opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  await chmod(path, 0o644);
  return { content, path };
}

function stripLeadingDot(d: string): string {
  return d.startsWith(".") ? d.slice(1) : d;
}
