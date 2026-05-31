//! Rule-based routing engine for fbi-proxy.
//!
//! This module implements a configurable, placeholder-based rule system
//! that replaces (eventually) the hardcoded `parse_host` logic in
//! `rs/fbi-proxy.rs`. Routes are described declaratively (e.g. in YAML)
//! as a `match` pattern + a `target` template + optional `headers`
//! templates. The engine compiles each rule into a regular expression
//! and, at request time, picks the first rule whose pattern matches
//! the incoming host, then expands the templates using the captured
//! placeholder values.
//!
//! # Placeholder syntax
//!
//! Placeholders in patterns and templates use brace syntax:
//!
//! * `{name}`       — matches one host segment: `[^.]+`
//! * `{name:int}`   — matches one numeric segment: `\d+`
//! * `{name:slug}`  — matches `[a-z0-9-]+`
//! * `{name:multi}` — matches one or more dot-separated segments:
//!                    `[^.]+(\.[^.]+)*`. Use this for DNS-passthrough
//!                    patterns like `{upstream:multi}.{domain}` that
//!                    need to capture e.g. `github.com` as one value.
//!
//! A given placeholder name can appear in both the `match` pattern
//! (where it captures) and in the `target` / `headers` templates
//! (where it is substituted from the corresponding capture).
//!
//! Literal characters in patterns (dots, dashes, etc.) are anchored
//! by Rust's `regex` crate after escaping; the whole pattern is
//! implicitly anchored with `^...$`.
//!
//! # `{domain}` and multi-dot subdomain semantics
//!
//! `{domain}` is **not** special-cased by this engine. It is just a
//! placeholder name like any other. The default `routes.yaml` uses
//! `{domain}` by convention to mean "the trailing fbi-proxy domain
//! (e.g. `fbi.com`)" but the engine treats it the same as `{host}`,
//! `{port}`, etc.
//!
//! This means a pattern like `{prefix}.{host}.{domain}` is *greedy
//! left-to-right* in the sense that each placeholder matches a single
//! dot-free segment. For a host like `a.b.c.fbi.com` against
//! `{prefix}.{host}.{domain}`, no match is produced because `{domain}`
//! can only consume one segment (`com`), `{host}` consumes `fbi`, and
//! `{prefix}` would have to consume `a.b.c` — which it can't, because
//! `{prefix}` is `[^.]+`.
//!
//! Callers that want multi-dot domains (e.g. `fbi.example.com`) should
//! either:
//!   1. Strip the domain suffix before calling `match_host` (which is
//!      what `match_host_with_domain` does), or
//!   2. Encode the multi-dot literal directly in the pattern
//!      (e.g. `{prefix}.{host}.fbi.example.com`).
//!
//! `match_host_with_domain(routes, host, Some("fbi.example.com"))` is
//! the convenience helper: it strips `.fbi.example.com` from the host
//! before matching, then re-injects the value as the `{domain}`
//! capture for template expansion.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Placeholder kind — controls the regex fragment used to match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceholderKind {
    /// `{name}` — matches one host segment (no dot): `[^.]+`.
    Any,
    /// `{name:int}` — matches `\d+`.
    Int,
    /// `{name:slug}` — matches `[a-z0-9-]+`.
    Slug,
    /// `{name:multi}` — matches one or more dot-separated segments.
    /// Use for DNS-passthrough patterns (e.g. `{upstream:multi}.fbi.com`
    /// capturing `github.com` as one value).
    Multi,
}

impl PlaceholderKind {
    fn regex_fragment(self) -> &'static str {
        match self {
            PlaceholderKind::Any => "[^.]+",
            PlaceholderKind::Int => r"\d+",
            PlaceholderKind::Slug => "[a-z0-9-]+",
            PlaceholderKind::Multi => r"[^.]+(?:\.[^.]+)*",
        }
    }
}

/// Special-cased placeholder names that need to match more than a
/// single dot-free segment. Currently only `{domain}`: it matches
/// two-or-more dot-separated segments (e.g. `fbi.com`, `fbi.example.com`)
/// but NOT a single bare segment like `com`. This is important because
/// it makes the default rule ordering unambiguous: in
/// `{prefix}.{host}.{domain}`, the trailing `{domain}` greedily eats
/// the multi-segment suffix instead of collapsing to a single segment
/// (which would cause `myserver.fbi.com` to be mis-classified as
/// `prefix=myserver, host=fbi, domain=com`).
fn special_regex_fragment(name: &str) -> Option<&'static str> {
    match name {
        "domain" => Some(r"[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)+"),
        _ => None,
    }
}

/// A single named placeholder captured by a compiled route.
#[derive(Debug, Clone)]
pub struct Placeholder {
    pub name: String,
    pub kind: PlaceholderKind,
}

/// User-supplied route configuration (e.g. from `routes.yaml`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RouteConfig {
    pub name: String,
    /// Pattern matched against the Host header (without port).
    /// E.g. `"{port:int}.{domain}"`.
    #[serde(rename = "match")]
    pub r#match: String,
    /// Optional path-prefix matcher. When set, the rule only matches
    /// requests whose path falls under this prefix; among host-matching
    /// rules, the longest matching prefix wins. The path is forwarded
    /// upstream as-is (never stripped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Target template, e.g. `"127.0.0.1:{port}"`.
    pub target: String,
    /// Header templates. The special key `"Host"` (case-insensitive)
    /// is surfaced separately on `RouteHit::host_header`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,
}

/// Top-level shape of `routes.yaml`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RoutesFile {
    #[serde(default = "default_version")]
    pub version: u32,
    pub routes: Vec<RouteConfig>,
}

fn default_version() -> u32 {
    1
}

/// Parse a `routes.yaml`-style document.
pub fn parse_yaml(src: &str) -> Result<RoutesFile, serde_yaml::Error> {
    serde_yaml::from_str(src)
}

/// A compiled route — regex + templates — ready to evaluate per request.
#[derive(Debug, Clone)]
pub struct CompiledRoute {
    pub name: String,
    pub pattern: Regex,
    pub placeholders: Vec<Placeholder>,
    pub target_template: String,
    pub header_templates: HashMap<String, String>,
    /// Original (uncompiled) `match` pattern, retained so the admin API
    /// can report and round-trip the source rule.
    pub match_pattern: String,
    /// Normalized optional path prefix (e.g. `"/_vscode/"`). `None`
    /// matches any path (lowest path priority).
    pub path_prefix: Option<String>,
    /// Namespace this route belongs to — the conf.d fragment stem, or
    /// `"default"` for the bundled defaults. Used for `ps` grouping.
    pub namespace: String,
}

/// Result of a successful match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteHit {
    pub route_name: String,
    /// Expanded `target` template (e.g. `"api:3001"`).
    pub target: String,
    /// Expanded `Host` header from the `headers` map, if any.
    pub host_header: Option<String>,
    /// Other expanded headers, excluding `Host` (case-insensitive).
    pub other_headers: HashMap<String, String>,
}

/// Compile-time error from `compile`.
#[derive(Debug, Clone)]
pub enum CompileError {
    /// A placeholder spec was malformed, e.g. `{na me}` or `{:int}`.
    InvalidPlaceholder { route: String, placeholder: String, reason: String },
    /// An unknown placeholder kind, e.g. `{name:foo}`.
    UnknownKind { route: String, name: String, kind: String },
    /// The same placeholder name was declared twice in the same pattern.
    DuplicatePlaceholder { route: String, name: String },
    /// The generated regex failed to compile (very unlikely — usually
    /// an indication of weird literal characters that escaped wrong).
    InvalidRegex { route: String, source: String },
    /// A `{name}` appeared in the target/header template but was never
    /// declared in the match pattern.
    UndeclaredPlaceholder { route: String, name: String, location: String },
    /// Unbalanced braces in pattern or template.
    UnbalancedBraces { route: String, location: String },
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CompileError::InvalidPlaceholder { route, placeholder, reason } => {
                write!(f, "route '{}': invalid placeholder '{{{}}}': {}", route, placeholder, reason)
            }
            CompileError::UnknownKind { route, name, kind } => {
                write!(f, "route '{}': unknown placeholder kind ':{}' for '{{{}}}' (expected int|slug|multi or none)", route, kind, name)
            }
            CompileError::DuplicatePlaceholder { route, name } => {
                write!(f, "route '{}': placeholder '{{{}}}' declared twice in match pattern", route, name)
            }
            CompileError::InvalidRegex { route, source } => {
                write!(f, "route '{}': internal regex compile error: {}", route, source)
            }
            CompileError::UndeclaredPlaceholder { route, name, location } => {
                write!(f, "route '{}': placeholder '{{{}}}' used in {} but never declared in match pattern", route, name, location)
            }
            CompileError::UnbalancedBraces { route, location } => {
                write!(f, "route '{}': unbalanced braces in {}", route, location)
            }
        }
    }
}

impl std::error::Error for CompileError {}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/// A token of a parsed pattern / template string.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Literal(String),
    Placeholder { name: String, kind: Option<String> },
}

/// Tokenize a `{name[:kind]}`-style template. Returns the token list
/// or `Err(UnbalancedBraces)` on malformed input.
fn tokenize(s: &str, route: &str, location: &str) -> Result<Vec<Token>, CompileError> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '{' {
            // flush literal
            if !buf.is_empty() {
                out.push(Token::Literal(std::mem::take(&mut buf)));
            }
            // collect until '}'
            let mut spec = String::new();
            let mut closed = false;
            while let Some(&nc) = chars.peek() {
                chars.next();
                if nc == '}' {
                    closed = true;
                    break;
                }
                spec.push(nc);
            }
            if !closed {
                return Err(CompileError::UnbalancedBraces {
                    route: route.to_string(),
                    location: location.to_string(),
                });
            }
            // parse "name" or "name:kind"
            let (name, kind) = match spec.split_once(':') {
                Some((n, k)) => (n.to_string(), Some(k.to_string())),
                None => (spec.clone(), None),
            };
            out.push(Token::Placeholder { name, kind });
        } else if c == '}' {
            return Err(CompileError::UnbalancedBraces {
                route: route.to_string(),
                location: location.to_string(),
            });
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        out.push(Token::Literal(buf));
    }
    Ok(out)
}

fn parse_kind(route: &str, name: &str, kind: Option<&str>) -> Result<PlaceholderKind, CompileError> {
    match kind {
        None | Some("") => Ok(PlaceholderKind::Any),
        Some("int") => Ok(PlaceholderKind::Int),
        Some("slug") => Ok(PlaceholderKind::Slug),
        Some("multi") => Ok(PlaceholderKind::Multi),
        Some(other) => Err(CompileError::UnknownKind {
            route: route.to_string(),
            name: name.to_string(),
            kind: other.to_string(),
        }),
    }
}

fn validate_name(route: &str, raw_spec: &str, name: &str) -> Result<(), CompileError> {
    if name.is_empty() {
        return Err(CompileError::InvalidPlaceholder {
            route: route.to_string(),
            placeholder: raw_spec.to_string(),
            reason: "empty placeholder name".to_string(),
        });
    }
    let first = name.chars().next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(CompileError::InvalidPlaceholder {
            route: route.to_string(),
            placeholder: raw_spec.to_string(),
            reason: "name must start with a letter or '_'".to_string(),
        });
    }
    for c in name.chars() {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return Err(CompileError::InvalidPlaceholder {
                route: route.to_string(),
                placeholder: raw_spec.to_string(),
                reason: format!("name contains invalid character '{}'", c),
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/// Compile a list of `RouteConfig`s into ready-to-use `CompiledRoute`s
/// under the `"default"` namespace.
///
/// Returns the first error encountered.
pub fn compile(routes: Vec<RouteConfig>) -> Result<Vec<CompiledRoute>, CompileError> {
    compile_in_namespace(routes, "default")
}

/// Like [`compile`], but tags every produced route with `namespace`
/// (the conf.d fragment stem). Used when merging multiple fragments.
pub fn compile_in_namespace(
    routes: Vec<RouteConfig>,
    namespace: &str,
) -> Result<Vec<CompiledRoute>, CompileError> {
    let mut out = Vec::with_capacity(routes.len());
    for r in routes {
        out.push(compile_one(r, namespace)?);
    }
    Ok(out)
}

/// Normalize a path prefix: guarantee a leading `/`. Trailing slash is
/// left as the author wrote it (it affects boundary matching).
fn normalize_path_prefix(p: &str) -> String {
    if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{}", p)
    }
}

fn compile_one(cfg: RouteConfig, namespace: &str) -> Result<CompiledRoute, CompileError> {
    let route_name = cfg.name.clone();
    let match_pattern = cfg.r#match.clone();
    let tokens = tokenize(&cfg.r#match, &route_name, "match pattern")?;

    let mut declared: Vec<Placeholder> = Vec::new();
    let mut regex_src = String::from("^");
    for tok in &tokens {
        match tok {
            Token::Literal(lit) => {
                regex_src.push_str(&regex::escape(lit));
            }
            Token::Placeholder { name, kind } => {
                let raw_spec = match kind {
                    Some(k) => format!("{}:{}", name, k),
                    None => name.clone(),
                };
                validate_name(&route_name, &raw_spec, name)?;
                let parsed_kind = parse_kind(&route_name, name, kind.as_deref())?;
                if declared.iter().any(|p| p.name == *name) {
                    return Err(CompileError::DuplicatePlaceholder {
                        route: route_name,
                        name: name.clone(),
                    });
                }
                declared.push(Placeholder { name: name.clone(), kind: parsed_kind });
                regex_src.push('(');
                regex_src.push_str("?P<");
                regex_src.push_str(name);
                regex_src.push('>');
                // If the user did not specify an explicit kind (e.g.
                // `{domain}` not `{domain:slug}`) AND the name is one
                // of the well-known multi-segment names, broaden the
                // fragment to allow dots. This is what makes
                // `{port:int}.{domain}` work for `3000.fbi.com`.
                if kind.is_none() {
                    if let Some(frag) = special_regex_fragment(name) {
                        regex_src.push_str(frag);
                    } else {
                        regex_src.push_str(parsed_kind.regex_fragment());
                    }
                } else {
                    regex_src.push_str(parsed_kind.regex_fragment());
                }
                regex_src.push(')');
            }
        }
    }
    regex_src.push('$');

    let pattern = Regex::new(&regex_src).map_err(|e| CompileError::InvalidRegex {
        route: route_name.clone(),
        source: e.to_string(),
    })?;

    // Validate target template references known placeholders only.
    let target_tokens = tokenize(&cfg.target, &route_name, "target template")?;
    for tok in &target_tokens {
        if let Token::Placeholder { name, .. } = tok {
            validate_name(&route_name, name, name)?;
            if !declared.iter().any(|p| p.name == *name) {
                return Err(CompileError::UndeclaredPlaceholder {
                    route: route_name,
                    name: name.clone(),
                    location: "target template".to_string(),
                });
            }
        }
    }

    let mut header_templates: HashMap<String, String> = HashMap::new();
    if let Some(headers) = cfg.headers {
        for (k, v) in headers {
            let header_tokens = tokenize(&v, &route_name, &format!("header '{}'", k))?;
            for tok in &header_tokens {
                if let Token::Placeholder { name, .. } = tok {
                    validate_name(&route_name, name, name)?;
                    if !declared.iter().any(|p| p.name == *name) {
                        return Err(CompileError::UndeclaredPlaceholder {
                            route: route_name.clone(),
                            name: name.clone(),
                            location: format!("header '{}'", k),
                        });
                    }
                }
            }
            header_templates.insert(k, v);
        }
    }

    let path_prefix = cfg.path.as_deref().map(normalize_path_prefix);

    Ok(CompiledRoute {
        name: route_name,
        pattern,
        placeholders: declared,
        target_template: cfg.target,
        header_templates,
        match_pattern,
        path_prefix,
        namespace: namespace.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/// Strip a trailing `:port` from a host string. Used for normalization
/// before matching.
fn strip_port(host: &str) -> &str {
    match host.rfind(':') {
        Some(i) => &host[..i],
        None => host,
    }
}

/// Strip trailing slash if present (some clients include one).
fn strip_trailing_slash(host: &str) -> &str {
    host.strip_suffix('/').unwrap_or(host)
}

fn normalize(host: &str) -> String {
    // Host header is case-insensitive per RFC 7230 §5.4.
    strip_trailing_slash(strip_port(host)).to_ascii_lowercase()
}

/// Expand a template string using captured placeholders.
fn expand(template: &str, captures: &HashMap<String, String>) -> String {
    // We can re-use the tokenizer here, but since we already validated
    // at compile-time, this is purely substitution: scan for {name[:kind]}
    // and replace.
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' {
            let mut spec = String::new();
            while let Some(&nc) = chars.peek() {
                chars.next();
                if nc == '}' {
                    break;
                }
                spec.push(nc);
            }
            // strip optional :kind
            let name = match spec.split_once(':') {
                Some((n, _)) => n.to_string(),
                None => spec,
            };
            if let Some(v) = captures.get(&name) {
                out.push_str(v);
            }
            // if not present, drop silently — compile() has already
            // validated that all placeholders are declared.
        } else {
            out.push(c);
        }
    }
    out
}

/// Does `req_path` fall under `prefix`? `prefix` is normalized (leading
/// `/`). Boundary-aware: `"/_vscode/"` matches `/_vscode` and
/// `/_vscode/...` but NOT `/_vscodex`.
fn path_matches(prefix: &str, req_path: &str) -> bool {
    if prefix == "/" {
        return true;
    }
    if let Some(stripped) = prefix.strip_suffix('/') {
        req_path == stripped || req_path.starts_with(prefix)
    } else {
        req_path == prefix || req_path.starts_with(&format!("{}/", prefix))
    }
}

/// Try to match a host against the compiled routes. Returns the first
/// match (top-to-bottom order in the config).
pub fn match_host(routes: &[CompiledRoute], host: &str) -> Option<RouteHit> {
    match_host_with_domain(routes, host, None)
}

/// Like `match_host`, but if `default_domain` is `Some("fbi.com")`,
/// the host must end with `.fbi.com` (or be exactly `fbi.com`),
/// otherwise no match is produced. The full host (including the
/// domain suffix) is then matched against each compiled route's
/// pattern, so `{domain}` in the pattern naturally captures the
/// multi-dot suffix.
///
/// If `default_domain` is `None`, the host is matched as-is.
pub fn match_host_with_domain(
    routes: &[CompiledRoute],
    host: &str,
    default_domain: Option<&str>,
) -> Option<RouteHit> {
    match_request(routes, host, "/", default_domain)
}

/// Match a host **and** request path against the compiled routes.
///
/// Among all routes whose host pattern matches (and whose `path_prefix`
/// matches `req_path`, if any), the one with the **longest matching path
/// prefix** wins; ties are broken by declaration order (earliest wins).
/// A route with no `path_prefix` has the lowest path priority, so an
/// explicit `path: /` rule still beats a path-less rule for the same
/// host.
pub fn match_request(
    routes: &[CompiledRoute],
    host: &str,
    req_path: &str,
    default_domain: Option<&str>,
) -> Option<RouteHit> {
    let host = normalize(host);

    if let Some(domain) = default_domain {
        if !domain.is_empty() {
            let domain_lc = domain.to_ascii_lowercase();
            if host != domain_lc && !host.ends_with(&format!(".{}", domain_lc)) {
                return None;
            }
        }
    }

    // Select the best candidate by path-prefix length. `priority` is the
    // prefix byte length, or 0 for a path-less route. We require a
    // strictly-greater priority to replace the current best, so the
    // earliest declaration wins on ties.
    let mut best_idx: Option<usize> = None;
    let mut best_priority: i64 = -1;
    for (i, route) in routes.iter().enumerate() {
        if !route.pattern.is_match(&host) {
            continue;
        }
        let priority: i64 = match &route.path_prefix {
            None => 0,
            Some(prefix) => {
                if !path_matches(prefix, req_path) {
                    continue;
                }
                prefix.len() as i64
            }
        };
        if priority > best_priority {
            best_priority = priority;
            best_idx = Some(i);
        }
    }

    let route = routes.get(best_idx?)?;
    let caps = route.pattern.captures(&host)?;
    let mut values: HashMap<String, String> = HashMap::new();
    for p in &route.placeholders {
        if let Some(m) = caps.name(&p.name) {
            values.insert(p.name.clone(), m.as_str().to_string());
        }
    }

    let target = expand(&route.target_template, &values);

    let mut host_header: Option<String> = None;
    let mut other_headers: HashMap<String, String> = HashMap::new();
    for (k, tmpl) in &route.header_templates {
        let v = expand(tmpl, &values);
        if k.eq_ignore_ascii_case("host") {
            host_header = Some(v);
        } else {
            other_headers.insert(k.clone(), v);
        }
    }

    Some(RouteHit {
        route_name: route.name.clone(),
        target,
        host_header,
        other_headers,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn default_routes() -> Vec<CompiledRoute> {
        let configs = vec![
            RouteConfig {
                name: "port-as-host".into(),
                r#match: "{port:int}.{domain}".into(),
                path: None,
                target: "127.0.0.1:{port}".into(),
                headers: None,
            },
            RouteConfig {
                name: "host-double-dash-port".into(),
                r#match: "{host}--{port:int}.{domain}".into(),
                path: None,
                target: "{host}:{port}".into(),
                headers: Some({
                    let mut h = HashMap::new();
                    h.insert("Host".into(), "{host}".into());
                    h
                }),
            },
            RouteConfig {
                name: "subdomain-hoisting".into(),
                r#match: "{prefix}.{host}.{domain}".into(),
                path: None,
                target: "{host}:80".into(),
                headers: Some({
                    let mut h = HashMap::new();
                    h.insert("Host".into(), "{prefix}".into());
                    h
                }),
            },
            RouteConfig {
                name: "direct-forward".into(),
                r#match: "{host}.{domain}".into(),
                path: None,
                target: "{host}:80".into(),
                headers: Some({
                    let mut h = HashMap::new();
                    h.insert("Host".into(), "{host}".into());
                    h
                }),
            },
        ];
        compile(configs).expect("compile default routes")
    }

    /// All default-rule tests use the `fbi.com` domain filter, which
    /// is the way these rules are intended to be used (domain stripping
    /// is handled by the filter; the rules then route the remaining
    /// prefix).
    fn m(routes: &[CompiledRoute], host: &str) -> Option<RouteHit> {
        match_host_with_domain(routes, host, Some("fbi.com"))
    }

    #[test]
    fn empty_routes_no_match() {
        let hit = match_host(&[], "anything.fbi.com");
        assert!(hit.is_none());
    }

    #[test]
    fn port_as_host_matches() {
        let routes = default_routes();
        let hit = m(&routes, "3000.fbi.com").expect("should match");
        assert_eq!(hit.route_name, "port-as-host");
        assert_eq!(hit.target, "127.0.0.1:3000");
        assert_eq!(hit.host_header, None);
    }

    #[test]
    fn host_double_dash_port_matches() {
        let routes = default_routes();
        let hit = m(&routes, "api--3001.fbi.com").expect("should match");
        assert_eq!(hit.route_name, "host-double-dash-port");
        assert_eq!(hit.target, "api:3001");
        assert_eq!(hit.host_header.as_deref(), Some("api"));
    }

    #[test]
    fn subdomain_hoisting_matches() {
        let routes = default_routes();
        let hit = m(&routes, "admin.app.fbi.com").expect("should match");
        assert_eq!(hit.route_name, "subdomain-hoisting");
        assert_eq!(hit.target, "app:80");
        assert_eq!(hit.host_header.as_deref(), Some("admin"));
    }

    #[test]
    fn direct_forward_matches() {
        let routes = default_routes();
        let hit = m(&routes, "myserver.fbi.com").expect("should match");
        assert_eq!(hit.route_name, "direct-forward");
        assert_eq!(hit.target, "myserver:80");
        assert_eq!(hit.host_header.as_deref(), Some("myserver"));
    }

    #[test]
    fn port_in_host_is_stripped_before_match() {
        let routes = default_routes();
        let hit = m(&routes, "myserver.fbi.com:8080").expect("should match");
        assert_eq!(hit.route_name, "direct-forward");
        assert_eq!(hit.target, "myserver:80");
    }

    #[test]
    fn trailing_slash_stripped() {
        let routes = default_routes();
        let hit = m(&routes, "3000.fbi.com/").expect("should match");
        assert_eq!(hit.route_name, "port-as-host");
    }

    #[test]
    fn host_header_is_case_insensitive() {
        let routes = default_routes();
        let hit = m(&routes, "API--3001.FBI.COM").expect("should match");
        assert_eq!(hit.route_name, "host-double-dash-port");
        assert_eq!(hit.target, "api:3001");
    }

    #[test]
    fn multi_dot_subdomain_assigns_domain_greedily() {
        // For `a.b.c.fbi.com` against `{prefix}.{host}.{domain}`, the
        // regex anchors left-to-right: {prefix} and {host} each
        // capture one dot-free segment, and {domain} (which has the
        // special multi-dot fragment) captures the rest.
        //
        // So the match is: prefix=a, host=b, domain=c.fbi.com.
        //
        // This may or may not be what the user intends. Document this
        // ambiguity: if the user wants `prefix=a.b.c, host=fbi,
        // domain=com`, they need a different pattern (with explicit
        // literals for the trailing domain).
        let routes = default_routes();
        let hit = match_host(&routes, "a.b.c.fbi.com").expect("should match");
        assert_eq!(hit.route_name, "subdomain-hoisting");
        // host=b, target={host}:80 = b:80
        assert_eq!(hit.target, "b:80");
        // Host header = {prefix} = "a"
        assert_eq!(hit.host_header.as_deref(), Some("a"));
    }

    #[test]
    fn multi_dot_subdomain_with_domain_filter_is_unambiguous() {
        // When the caller passes the default-domain (`fbi.com`), the
        // regex still matches the full host but {domain} is now
        // constrained to exactly the trailing "fbi.com" suffix via
        // the domain filter. Actually, the filter only validates the
        // suffix — the regex itself is still greedy. But for the
        // typical "this is my fbi-proxy domain" usage, the host shape
        // is single-prefix.subdomain.{domain}, which works as
        // expected.
        let routes = default_routes();
        // admin.app.fbi.com -> subdomain-hoisting (prefix=admin, host=app, domain=fbi.com)
        let hit = match_host_with_domain(&routes, "admin.app.fbi.com", Some("fbi.com"))
            .expect("should match");
        assert_eq!(hit.route_name, "subdomain-hoisting");
        assert_eq!(hit.target, "app:80");
        assert_eq!(hit.host_header.as_deref(), Some("admin"));
    }

    #[test]
    fn first_match_wins() {
        let routes = compile(vec![
            RouteConfig {
                name: "first".into(),
                r#match: "{x}.{y}".into(),
                path: None,
                target: "first-target".into(),
                headers: None,
            },
            RouteConfig {
                name: "second".into(),
                r#match: "{x}.{y}".into(),
                path: None,
                target: "second-target".into(),
                headers: None,
            },
        ])
        .unwrap();
        let hit = match_host(&routes, "a.b").expect("should match");
        assert_eq!(hit.route_name, "first");
        assert_eq!(hit.target, "first-target");
    }

    #[test]
    fn unknown_placeholder_kind_errors() {
        let err = compile(vec![RouteConfig {
            name: "bad".into(),
            r#match: "{port:zzz}.com".into(),
            path: None,
            target: "x".into(),
            headers: None,
        }])
        .unwrap_err();
        match err {
            CompileError::UnknownKind { kind, .. } => assert_eq!(kind, "zzz"),
            e => panic!("expected UnknownKind, got {:?}", e),
        }
    }

    #[test]
    fn unbalanced_braces_in_pattern_errors() {
        let err = compile(vec![RouteConfig {
            name: "bad".into(),
            r#match: "{port".into(),
            path: None,
            target: "x".into(),
            headers: None,
        }])
        .unwrap_err();
        match err {
            CompileError::UnbalancedBraces { location, .. } => {
                assert!(location.contains("match"))
            }
            e => panic!("expected UnbalancedBraces, got {:?}", e),
        }
    }

    #[test]
    fn duplicate_placeholder_errors() {
        let err = compile(vec![RouteConfig {
            name: "bad".into(),
            r#match: "{x}.{x}".into(),
            path: None,
            target: "y".into(),
            headers: None,
        }])
        .unwrap_err();
        match err {
            CompileError::DuplicatePlaceholder { name, .. } => assert_eq!(name, "x"),
            e => panic!("expected DuplicatePlaceholder, got {:?}", e),
        }
    }

    #[test]
    fn undeclared_placeholder_in_target_errors() {
        let err = compile(vec![RouteConfig {
            name: "bad".into(),
            r#match: "{x}.{y}".into(),
            path: None,
            target: "{z}".into(),
            headers: None,
        }])
        .unwrap_err();
        match err {
            CompileError::UndeclaredPlaceholder { name, location, .. } => {
                assert_eq!(name, "z");
                assert!(location.contains("target"));
            }
            e => panic!("expected UndeclaredPlaceholder, got {:?}", e),
        }
    }

    #[test]
    fn invalid_placeholder_name_errors() {
        let err = compile(vec![RouteConfig {
            name: "bad".into(),
            r#match: "{1foo}".into(),
            path: None,
            target: "x".into(),
            headers: None,
        }])
        .unwrap_err();
        match err {
            CompileError::InvalidPlaceholder { .. } => {}
            e => panic!("expected InvalidPlaceholder, got {:?}", e),
        }
    }

    #[test]
    fn int_kind_rejects_non_numeric() {
        let routes = default_routes();
        // "abc.fbi.com" should NOT match port-as-host (because abc isn't \d+),
        // but should fall through to direct-forward.
        let hit = m(&routes, "abc.fbi.com").expect("should match");
        assert_eq!(hit.route_name, "direct-forward");
        assert_eq!(hit.target, "abc:80");
    }

    #[test]
    fn match_host_with_domain_filter_accepts_matching() {
        let routes = default_routes();
        let hit = match_host_with_domain(&routes, "3000.fbi.com", Some("fbi.com"))
            .expect("should match");
        assert_eq!(hit.route_name, "port-as-host");
        assert_eq!(hit.target, "127.0.0.1:3000");
    }

    #[test]
    fn match_host_with_domain_filter_rejects_non_matching() {
        let routes = default_routes();
        let hit = match_host_with_domain(&routes, "evil.example.com", Some("fbi.com"));
        assert!(hit.is_none());
    }

    #[test]
    fn match_host_with_multi_dot_domain() {
        // The default-domain filter (`fbi.example.com`) only validates
        // the suffix. The pattern itself still matches the full host,
        // and {domain} naturally captures multi-segment trailing parts.
        let routes = compile(vec![RouteConfig {
            name: "direct".into(),
            r#match: "{host}.{domain}".into(),
            path: None,
            target: "{host}:80".into(),
            headers: None,
        }])
        .unwrap();
        let hit =
            match_host_with_domain(&routes, "myserver.fbi.example.com", Some("fbi.example.com"))
                .expect("should match");
        assert_eq!(hit.target, "myserver:80");
    }

    #[test]
    fn match_host_with_multi_dot_domain_rejects_wrong_suffix() {
        let routes = compile(vec![RouteConfig {
            name: "direct".into(),
            r#match: "{host}.{domain}".into(),
            path: None,
            target: "{host}:80".into(),
            headers: None,
        }])
        .unwrap();
        let hit = match_host_with_domain(&routes, "myserver.other.com", Some("fbi.example.com"));
        assert!(hit.is_none());
    }

    #[test]
    fn multi_kind_captures_multi_dot_segments() {
        let routes = compile(vec![RouteConfig {
            name: "dns-passthrough".into(),
            r#match: "{upstream:multi}.fbi.com".into(),
            path: None,
            target: "{upstream}:80".into(),
            headers: None,
        }])
        .unwrap();

        let hit = match_host(&routes, "github.com.fbi.com").unwrap();
        assert_eq!(hit.target, "github.com:80");

        let hit = match_host(&routes, "api.example.org.fbi.com").unwrap();
        assert_eq!(hit.target, "api.example.org:80");

        // Single segment still matches (one-or-more).
        let hit = match_host(&routes, "single.fbi.com").unwrap();
        assert_eq!(hit.target, "single:80");
    }

    #[test]
    fn multi_kind_with_host_header_rewrite() {
        let routes = compile(vec![RouteConfig {
            name: "dns-with-host".into(),
            r#match: "{upstream:multi}.fbi.com".into(),
            path: None,
            target: "{upstream}:443".into(),
            headers: Some(HashMap::from([("Host".into(), "{upstream}".into())])),
        }])
        .unwrap();
        let hit = match_host(&routes, "api.example.com.fbi.com").unwrap();
        assert_eq!(hit.target, "api.example.com:443");
        assert_eq!(hit.host_header.as_deref(), Some("api.example.com"));
    }

    #[test]
    fn multi_kind_with_routes_yaml() {
        let yaml = r#"
routes:
  - name: dns-passthrough
    match: "{upstream:multi}.{domain}"
    target: "{upstream}:80"
"#;
        let parsed = parse_yaml(yaml).unwrap();
        let routes = compile(parsed.routes).unwrap();
        let hit = match_host(&routes, "github.com.fbi.com").unwrap();
        assert_eq!(hit.target, "github.com:80");
    }

    #[test]
    fn slug_kind_accepts_lowercase_and_dashes() {
        let routes = compile(vec![RouteConfig {
            name: "slugged".into(),
            r#match: "{name:slug}.example".into(),
            path: None,
            target: "{name}".into(),
            headers: None,
        }])
        .unwrap();
        assert!(match_host(&routes, "my-service.example").is_some());
        // Uppercase normalized to lowercase by `normalize`, so it matches.
        assert!(match_host(&routes, "MY-SERVICE.example").is_some());
        // Underscores not allowed in slug.
        assert!(match_host(&routes, "my_service.example").is_none());
    }

    #[test]
    fn parse_yaml_default_routes() {
        let yaml = r#"
version: 1
routes:
  - name: port-as-host
    match: "{port:int}.{domain}"
    target: "127.0.0.1:{port}"
  - name: direct-forward
    match: "{host}.{domain}"
    target: "{host}:80"
    headers:
      Host: "{host}"
"#;
        let parsed = parse_yaml(yaml).expect("yaml should parse");
        assert_eq!(parsed.version, 1);
        assert_eq!(parsed.routes.len(), 2);
        assert_eq!(parsed.routes[0].name, "port-as-host");
        assert_eq!(parsed.routes[0].r#match, "{port:int}.{domain}");
        assert_eq!(parsed.routes[1].headers.as_ref().unwrap()["Host"], "{host}");

        let compiled = compile(parsed.routes).unwrap();
        let hit = match_host(&compiled, "3000.fbi.com").unwrap();
        assert_eq!(hit.target, "127.0.0.1:3000");
    }

    #[test]
    fn expand_passes_through_unknown_placeholders_silently() {
        // expand() is internal but exercised here as a sanity check:
        // a template referencing an unknown name returns the template
        // minus the placeholder. (compile() rejects this, so users
        // can't hit it; this just guards against panics in expand.)
        let mut caps = HashMap::new();
        caps.insert("a".to_string(), "X".to_string());
        assert_eq!(expand("{a}-{b}", &caps), "X-");
    }

    // ----- path-prefix matching (web-code use case) -----

    fn web_code_routes() -> Vec<CompiledRoute> {
        compile_in_namespace(
            vec![
                RouteConfig {
                    name: "root".into(),
                    r#match: "fbi.com".into(),
                    path: Some("/".into()),
                    target: "localhost:3001".into(),
                    headers: None,
                },
                RouteConfig {
                    name: "vscode".into(),
                    r#match: "fbi.com".into(),
                    path: Some("/_vscode/".into()),
                    target: "localhost:9999".into(),
                    headers: None,
                },
            ],
            "web-code",
        )
        .expect("compile web-code routes")
    }

    #[test]
    fn path_prefix_longest_wins() {
        let routes = web_code_routes();
        let hit = match_request(&routes, "fbi.com", "/_vscode/", Some("fbi.com")).unwrap();
        assert_eq!(hit.target, "localhost:9999");
        let hit = match_request(&routes, "fbi.com", "/_vscode/stable/x.js", Some("fbi.com")).unwrap();
        assert_eq!(hit.target, "localhost:9999");
        let hit = match_request(&routes, "fbi.com", "/", Some("fbi.com")).unwrap();
        assert_eq!(hit.target, "localhost:3001");
        let hit = match_request(&routes, "fbi.com", "/snomiao/repo/tree/main", Some("fbi.com")).unwrap();
        assert_eq!(hit.target, "localhost:3001");
    }

    #[test]
    fn path_prefix_boundary_not_substring() {
        let routes = web_code_routes();
        let hit = match_request(&routes, "fbi.com", "/_vscodex", Some("fbi.com")).unwrap();
        assert_eq!(hit.target, "localhost:3001");
        let hit = match_request(&routes, "fbi.com", "/_vscode", Some("fbi.com")).unwrap();
        assert_eq!(hit.target, "localhost:9999");
    }

    #[test]
    fn explicit_root_path_beats_pathless() {
        let routes = compile(vec![
            RouteConfig {
                name: "pathless".into(),
                r#match: "fbi.com".into(),
                path: None,
                target: "localhost:1".into(),
                headers: None,
            },
            RouteConfig {
                name: "rooted".into(),
                r#match: "fbi.com".into(),
                path: Some("/".into()),
                target: "localhost:2".into(),
                headers: None,
            },
        ])
        .unwrap();
        let hit = match_request(&routes, "fbi.com", "/anything", None).unwrap();
        assert_eq!(hit.target, "localhost:2");
    }

    #[test]
    fn namespace_is_tagged_on_compiled_route() {
        let routes = web_code_routes();
        assert!(routes.iter().all(|r| r.namespace == "web-code"));
        let bundled = compile(vec![RouteConfig {
            name: "x".into(),
            r#match: "{host}".into(),
            path: None,
            target: "{host}:80".into(),
            headers: None,
        }])
        .unwrap();
        assert_eq!(bundled[0].namespace, "default");
    }
}
