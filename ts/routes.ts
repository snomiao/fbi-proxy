/**
 * Route configuration types for fbi-proxy's rule-based router.
 *
 * The matching engine itself lives in `rs/routes.rs` (Rust). This
 * TypeScript module mirrors the public configuration shape so that
 * CLI / wizard code can author, parse, and validate `routes.yaml`
 * documents without invoking the Rust binary.
 *
 * See `docs/routing.md` for the user-facing reference.
 */

import YAML from "yaml";

/** A placeholder declared in a route's `match` pattern. */
export type Placeholder = {
  name: string;
  kind: "any" | "int" | "slug" | "multi";
};

/** A single route entry in `routes.yaml`. */
export type RouteConfig = {
  /** Human-readable name (also used as a debug label). */
  name: string;
  /**
   * Pattern matched against the (port-stripped, lowercased) Host header.
   * Placeholders: `{name}` (any segment), `{name:int}`, `{name:slug}`,
   * `{name:multi}` (one or more dot-segments — for DNS-passthrough).
   */
  match: string;
  /**
   * Target template. Expanded with placeholder captures from `match`.
   * E.g. `"127.0.0.1:{port}"`.
   */
  target: string;
  /**
   * Optional header templates. `Host` is treated specially by the
   * proxy (it rewrites the outgoing Host header); other entries are
   * added to the upstream request as-is.
   */
  headers?: Record<string, string>;
};

/** Top-level shape of `routes.yaml`. */
export type RoutesFile = {
  version: 1;
  routes: RouteConfig[];
};

/** Result type for `validateRoute`. */
export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Parse a YAML string into a `RoutesFile`. Throws on syntactically
 * invalid YAML or on missing required fields. Does NOT compile the
 * `match` patterns — call into the Rust engine for that.
 */
export function parseRoutesYaml(yaml: string): RoutesFile {
  const raw = YAML.parse(yaml);
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("routes.yaml must be a YAML mapping at the top level");
  }
  const obj = raw as Record<string, unknown>;
  const version = (obj.version ?? 1) as number;
  if (version !== 1) {
    throw new Error(`routes.yaml: unsupported version ${version} (expected 1)`);
  }
  if (!Array.isArray(obj.routes)) {
    throw new Error("routes.yaml: `routes` must be a list");
  }
  const routes: RouteConfig[] = [];
  for (let i = 0; i < obj.routes.length; i++) {
    const entry = obj.routes[i];
    if (entry == null || typeof entry !== "object") {
      throw new Error(`routes.yaml: entry #${i} must be a mapping`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.length === 0) {
      throw new Error(`routes.yaml: entry #${i} is missing a string \`name\``);
    }
    if (typeof e.match !== "string" || e.match.length === 0) {
      throw new Error(
        `routes.yaml: entry '${e.name}' is missing a string \`match\``,
      );
    }
    if (typeof e.target !== "string" || e.target.length === 0) {
      throw new Error(
        `routes.yaml: entry '${e.name}' is missing a string \`target\``,
      );
    }
    let headers: Record<string, string> | undefined;
    if (e.headers != null) {
      if (typeof e.headers !== "object" || Array.isArray(e.headers)) {
        throw new Error(
          `routes.yaml: entry '${e.name}': \`headers\` must be a mapping`,
        );
      }
      headers = {};
      for (const [hk, hv] of Object.entries(
        e.headers as Record<string, unknown>,
      )) {
        if (typeof hv !== "string") {
          throw new Error(
            `routes.yaml: entry '${e.name}': header '${hk}' must be a string`,
          );
        }
        headers[hk] = hv;
      }
    }
    routes.push({
      name: e.name,
      match: e.match,
      target: e.target,
      headers,
    });
  }
  return { version: 1, routes };
}

const PLACEHOLDER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_KINDS = new Set(["", "int", "slug", "multi"]);

/** Find all `{name[:kind]}` placeholders in `s`. */
function placeholdersIn(s: string): Placeholder[] {
  const out: Placeholder[] = [];
  const re = /\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const spec = m[1];
    const idx = spec.indexOf(":");
    const name = idx === -1 ? spec : spec.slice(0, idx);
    const rawKind = idx === -1 ? "" : spec.slice(idx + 1);
    let kind: Placeholder["kind"];
    if (rawKind === "" || rawKind === "any") kind = "any";
    else if (rawKind === "int") kind = "int";
    else if (rawKind === "slug") kind = "slug";
    else if (rawKind === "multi") kind = "multi";
    else kind = "any"; // validation pass will reject if not in VALID_KINDS
    out.push({ name, kind });
  }
  return out;
}

function bracesBalanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Validate a single route entry. Returns `{valid: true}` or
 * `{valid: false, reason}`. This is the same set of checks the Rust
 * compiler runs at startup, kept in sync for editor-time validation.
 */
export function validateRoute(r: RouteConfig): ValidationResult {
  if (!r.name) return { valid: false, reason: "route name is required" };
  if (!r.match) return { valid: false, reason: "route `match` is required" };
  if (!r.target) return { valid: false, reason: "route `target` is required" };

  if (!bracesBalanced(r.match))
    return { valid: false, reason: "unbalanced braces in `match`" };
  if (!bracesBalanced(r.target))
    return { valid: false, reason: "unbalanced braces in `target`" };

  // Verify placeholder names + kinds in match
  const declared = new Set<string>();
  const matchPhs = placeholdersIn(r.match);
  // Re-scan match raw to catch unknown kinds (placeholdersIn coerces them).
  const rawMatchRe = /\{([^}]*)\}/g;
  let mm: RegExpExecArray | null;
  while ((mm = rawMatchRe.exec(r.match)) !== null) {
    const spec = mm[1];
    const idx = spec.indexOf(":");
    const name = idx === -1 ? spec : spec.slice(0, idx);
    const kind = idx === -1 ? "" : spec.slice(idx + 1);
    if (!PLACEHOLDER_NAME_RE.test(name))
      return {
        valid: false,
        reason: `invalid placeholder name '{${spec}}' in \`match\``,
      };
    if (!VALID_KINDS.has(kind))
      return {
        valid: false,
        reason: `unknown placeholder kind ':${kind}' for '{${name}}' (expected int|slug|multi)`,
      };
    if (declared.has(name))
      return {
        valid: false,
        reason: `placeholder '{${name}}' declared twice in \`match\``,
      };
    declared.add(name);
  }
  void matchPhs;

  // Verify target / headers reference only declared placeholders
  for (const ph of placeholdersIn(r.target)) {
    if (!PLACEHOLDER_NAME_RE.test(ph.name))
      return {
        valid: false,
        reason: `invalid placeholder name '{${ph.name}}' in \`target\``,
      };
    if (!declared.has(ph.name))
      return {
        valid: false,
        reason: `placeholder '{${ph.name}}' used in \`target\` but not declared in \`match\``,
      };
  }
  if (r.headers) {
    for (const [hk, hv] of Object.entries(r.headers)) {
      if (!bracesBalanced(hv))
        return {
          valid: false,
          reason: `unbalanced braces in header '${hk}'`,
        };
      for (const ph of placeholdersIn(hv)) {
        if (!PLACEHOLDER_NAME_RE.test(ph.name))
          return {
            valid: false,
            reason: `invalid placeholder name '{${ph.name}}' in header '${hk}'`,
          };
        if (!declared.has(ph.name))
          return {
            valid: false,
            reason: `placeholder '{${ph.name}}' used in header '${hk}' but not declared in \`match\``,
          };
      }
    }
  }

  return { valid: true };
}
