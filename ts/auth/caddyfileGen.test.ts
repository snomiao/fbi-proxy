import { describe, it, expect } from "vitest";
import { generateCaddyfile } from "./caddyfileGen";

describe("generateCaddyfile", () => {
  it("emits the canonical fbi.com + auth + tls internal layout", () => {
    const out = generateCaddyfile({
      domain: "fbi.com",
      ssoHost: "sso.fbi.com",
      fbiAuthPort: 2433,
      fbiProxyPort: 2432,
      tlsMode: "internal",
      withAuth: true,
    });

    expect(out).toMatchInlineSnapshot(`
      "sso.fbi.com {
        reverse_proxy 127.0.0.1:2433
        tls internal
      }

      *.fbi.com {
        @notauth not path /api/auth/* /login /callback /logout
        forward_auth @notauth 127.0.0.1:2433 {
          uri /api/auth/verify
          copy_headers Remote-User Remote-Email Remote-Name
          header_up X-Forwarded-Host {host}
          header_up X-Forwarded-Uri {uri}
        }
        reverse_proxy 127.0.0.1:2432
        tls internal
      }
      "
    `);
  });

  it("emits ACME email block + auto TLS for a public domain with --with-auth", () => {
    const out = generateCaddyfile({
      domain: "example.dev",
      ssoHost: "sso.example.dev",
      fbiAuthPort: 2433,
      fbiProxyPort: 2432,
      acmeEmail: "ops@example.dev",
      tlsMode: "auto",
      withAuth: true,
    });

    expect(out).toMatchInlineSnapshot(`
      "{
        email ops@example.dev
      }

      sso.example.dev {
        reverse_proxy 127.0.0.1:2433
      }

      *.example.dev {
        @notauth not path /api/auth/* /login /callback /logout
        forward_auth @notauth 127.0.0.1:2433 {
          uri /api/auth/verify
          copy_headers Remote-User Remote-Email Remote-Name
          header_up X-Forwarded-Host {host}
          header_up X-Forwarded-Uri {uri}
        }
        reverse_proxy 127.0.0.1:2432
      }
      "
    `);
  });

  it("auto TLS = no tls stanza, no global block when no ACME email", () => {
    const out = generateCaddyfile({
      domain: "example.dev",
      ssoHost: "sso.example.dev",
      fbiAuthPort: 2433,
      fbiProxyPort: 2432,
      tlsMode: "auto",
      withAuth: true,
    });

    expect(out).not.toContain("tls internal");
    expect(out).not.toMatch(/^\{\s*email/);
    expect(out).toContain("sso.example.dev {");
    expect(out).toContain("*.example.dev {");
    expect(out).toContain("forward_auth @notauth 127.0.0.1:2433");
    expect(out).toContain("reverse_proxy 127.0.0.1:2432");
  });

  it("--with-caddy without --with-auth: only *.domain block, no forward_auth", () => {
    const out = generateCaddyfile({
      domain: "fbi.com",
      fbiProxyPort: 2432,
      tlsMode: "internal",
      withAuth: false,
    });

    expect(out).toMatchInlineSnapshot(`
      "*.fbi.com {
        reverse_proxy 127.0.0.1:2432
        tls internal
      }
      "
    `);
    expect(out).not.toContain("forward_auth");
    expect(out).not.toContain("sso.fbi.com");
  });

  it("--with-caddy standalone, public domain + ACME email", () => {
    const out = generateCaddyfile({
      domain: "example.dev",
      fbiProxyPort: 2432,
      acmeEmail: "ops@example.dev",
      tlsMode: "auto",
      withAuth: false,
    });

    expect(out).toContain("email ops@example.dev");
    expect(out).toContain("*.example.dev {");
    expect(out).toContain("reverse_proxy 127.0.0.1:2432");
    expect(out).not.toContain("forward_auth");
    expect(out).not.toContain("sso.");
    expect(out).not.toContain("tls internal");
  });

  it("strips a leading dot from the domain", () => {
    const out = generateCaddyfile({
      domain: ".fbi.com",
      fbiProxyPort: 2432,
      tlsMode: "internal",
      withAuth: false,
    });
    expect(out).toContain("*.fbi.com {");
    expect(out).not.toContain("*..fbi.com");
  });

  it("throws when withAuth is true but fbiAuthPort is missing", () => {
    expect(() =>
      generateCaddyfile({
        domain: "fbi.com",
        fbiProxyPort: 2432,
        withAuth: true,
        tlsMode: "internal",
      }),
    ).toThrow(/fbiAuthPort/);
  });

  it("omits the global email block when acmeEmail is empty string", () => {
    const out = generateCaddyfile({
      domain: "example.dev",
      fbiProxyPort: 2432,
      acmeEmail: "   ",
      tlsMode: "auto",
      withAuth: false,
    });
    expect(out).not.toMatch(/^\{/);
  });
});
