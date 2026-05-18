import { describe, expect, it } from "vitest";
import { parseRoutesYaml, validateRoute, type RouteConfig } from "./routes.ts";

const defaultYaml = `
version: 1
routes:
  - name: port-as-host
    match: "{port:int}.{domain}"
    target: "127.0.0.1:{port}"

  - name: host-double-dash-port
    match: "{host}--{port:int}.{domain}"
    target: "{host}:{port}"
    headers:
      Host: "{host}"

  - name: subdomain-hoisting
    match: "{prefix}.{host}.{domain}"
    target: "{host}:80"
    headers:
      Host: "{prefix}"

  - name: direct-forward
    match: "{host}.{domain}"
    target: "{host}:80"
    headers:
      Host: "{host}"
`;

describe("parseRoutesYaml", () => {
  it("parses the default 4-rule config", () => {
    const f = parseRoutesYaml(defaultYaml);
    expect(f.version).toBe(1);
    expect(f.routes).toHaveLength(4);
    expect(f.routes[0]).toEqual({
      name: "port-as-host",
      match: "{port:int}.{domain}",
      target: "127.0.0.1:{port}",
      headers: undefined,
    });
    expect(f.routes[1].headers).toEqual({ Host: "{host}" });
  });

  it("defaults missing version to 1", () => {
    const f = parseRoutesYaml(
      `routes:\n  - name: x\n    match: "{a}"\n    target: "b"\n`,
    );
    expect(f.version).toBe(1);
  });

  it("rejects unsupported version", () => {
    expect(() => parseRoutesYaml(`version: 2\nroutes: []\n`)).toThrow(
      /unsupported version/,
    );
  });

  it("rejects non-mapping top-level", () => {
    expect(() => parseRoutesYaml(`- a\n- b\n`)).toThrow(/mapping/);
  });

  it("rejects missing routes field", () => {
    expect(() => parseRoutesYaml(`version: 1\n`)).toThrow(
      /`routes` must be a list/,
    );
  });

  it("rejects entry missing name", () => {
    expect(() =>
      parseRoutesYaml(
        `version: 1\nroutes:\n  - match: "{a}"\n    target: "b"\n`,
      ),
    ).toThrow(/missing a string `name`/);
  });

  it("rejects entry missing match", () => {
    expect(() =>
      parseRoutesYaml(`version: 1\nroutes:\n  - name: x\n    target: "b"\n`),
    ).toThrow(/missing a string `match`/);
  });

  it("rejects non-string header value", () => {
    expect(() =>
      parseRoutesYaml(
        `version: 1\nroutes:\n  - name: x\n    match: "{a}"\n    target: "b"\n    headers:\n      Host: 123\n`,
      ),
    ).toThrow(/must be a string/);
  });
});

describe("validateRoute", () => {
  const good: RouteConfig = {
    name: "ok",
    match: "{port:int}.{domain}",
    target: "127.0.0.1:{port}",
    headers: { Host: "{domain}" },
  };

  it("accepts a valid route", () => {
    expect(validateRoute(good)).toEqual({ valid: true });
  });

  it("rejects empty name", () => {
    expect(validateRoute({ ...good, name: "" })).toEqual({
      valid: false,
      reason: "route name is required",
    });
  });

  it("rejects unbalanced braces in match", () => {
    expect(validateRoute({ ...good, match: "{port" })).toEqual({
      valid: false,
      reason: "unbalanced braces in `match`",
    });
  });

  it("rejects unknown placeholder kind", () => {
    const result = validateRoute({ ...good, match: "{port:zzz}.{domain}" });
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.reason).toMatch(/unknown placeholder kind ':zzz'/);
  });

  it("rejects undeclared placeholder in target", () => {
    const result = validateRoute({
      ...good,
      match: "{a}.{b}",
      target: "{c}",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/'{c}' used in `target`/);
  });

  it("rejects undeclared placeholder in header", () => {
    const result = validateRoute({
      ...good,
      match: "{a}.{b}",
      target: "x",
      headers: { Host: "{nope}" },
    });
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.reason).toMatch(/'{nope}' used in header 'Host'/);
  });

  it("rejects duplicate placeholder in match", () => {
    const result = validateRoute({ ...good, match: "{a}.{a}", target: "x" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/'{a}' declared twice/);
  });

  it("rejects invalid placeholder name", () => {
    const result = validateRoute({ ...good, match: "{1foo}", target: "x" });
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.reason).toMatch(/invalid placeholder name/);
  });

  it("validates all four default rules", () => {
    const f = parseRoutesYaml(defaultYaml);
    for (const r of f.routes) {
      expect(validateRoute(r)).toEqual({ valid: true });
    }
  });

  it("accepts {name:multi} for DNS-passthrough patterns", () => {
    const dnsRoute: RouteConfig = {
      name: "dns-passthrough",
      match: "{upstream:multi}.{domain}",
      target: "{upstream}:80",
    };
    expect(validateRoute(dnsRoute)).toEqual({ valid: true });
  });

  it("rejects {name:wrong} but accepts {name:multi}", () => {
    expect(
      validateRoute({ ...good, match: "{x:wrong}.{domain}", target: "x" }),
    ).toMatchObject({ valid: false });
    expect(
      validateRoute({ ...good, match: "{x:multi}.{domain}", target: "{x}" }),
    ).toEqual({ valid: true });
  });
});
