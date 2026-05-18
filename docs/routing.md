# Routing

fbi-proxy ships with a small, declarative rule engine that decides
where to send each incoming request based on its `Host` header. This
document describes how the rules are evaluated, what placeholders are
available, and how to add your own.

> **Status:** The rule engine (`rs/routes.rs`) and the default
> `routes.yaml` ship as of this release. The proxy binary still uses
> its built-in hardcoded routes; wiring the engine into the live
> request path is tracked separately and the defaults are guaranteed
> to reproduce existing behavior when that switch flips. **You do not
> need to do anything to keep your current setup working.**

## Why rule-based routing?

fbi-proxy started life with four routing rules baked into Rust source
code:

1. A bare-numeric subdomain (`3000.fbi.com`) maps to `localhost:3000`.
2. A `host--port` subdomain (`api--3001.fbi.com`) maps to `api:3001`.
3. A multi-part subdomain (`admin.app.fbi.com`) hoists the leftmost
   label into the `Host` header and targets the rest.
4. Anything else (`myserver.fbi.com`) targets `myserver:80`.

Four rules is fine until somebody wants a fifth. Maybe you'd like
`pr-1234.fbi.com` to go to the matching review app. Maybe you want
`staging-*.fbi.com` to send a custom header. Maybe you're running
fbi-proxy in front of three internal teams and they each need
different conventions.

The new engine lets you describe routes in YAML using a tiny
placeholder syntax. Same expressiveness as the hardcoded version (the
defaults are an exact reimplementation) plus the ability to add,
remove, or reorder rules without touching Rust.

## Default rules

The default `routes.yaml` at the repo root reproduces the original
behavior. Lines are evaluated top-to-bottom; the **first match wins**.

```yaml
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
```

| Rule                    | Example host        | Target           | `Host` rewritten to |
| ----------------------- | ------------------- | ---------------- | ------------------- |
| `port-as-host`          | `3000.fbi.com`      | `127.0.0.1:3000` | _(unchanged)_       |
| `host-double-dash-port` | `api--3001.fbi.com` | `api:3001`       | `api`               |
| `subdomain-hoisting`    | `admin.app.fbi.com` | `app:80`         | `admin`             |
| `direct-forward`        | `myserver.fbi.com`  | `myserver:80`    | `myserver`          |

Order matters. `port-as-host` must come before `host-double-dash-port`
to keep `3000.fbi.com` from being misclassified — the broader
`{host}--{port:int}` pattern wouldn't match `3000.fbi.com` anyway
(there's no `--`) but the principle is general: place the more
specific rules first.

## Placeholder syntax

Patterns and templates use a brace syntax:

| Form           | Matches                                      | Use for                                   |
| -------------- | -------------------------------------------- | ----------------------------------------- |
| `{name}`       | One host segment (no dot)                    | The common case                           |
| `{name:int}`   | `\d+` — one numeric segment                  | Ports, PR numbers, IDs                    |
| `{name:slug}`  | `[a-z0-9-]+` — DNS-friendly                  | Branch names, service identifiers         |
| `{name:multi}` | `[^.]+(\.[^.]+)*` — one or more dot-segments | DNS-passthrough, multi-dot upstream names |

There is one special placeholder name: **`{domain}`**. By convention
it captures the trailing fbi-proxy domain (e.g. `fbi.com`,
`fbi.example.com`). To make multi-dot domains work without requiring
the user to escape literals, `{domain}` matches _two or more_
dot-separated segments (regex `[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)+`).
This is what lets `{prefix}.{host}.{domain}` match
`admin.app.fbi.com` as `prefix=admin, host=app, domain=fbi.com`
instead of `prefix=admin, host=app.fbi, domain=com`.

Any placeholder name that appears in both `match` and
`target`/`headers` is substituted from the corresponding capture.
Placeholders in `target`/`headers` that aren't in `match` are a
compile error (caught at startup).

### Host normalization

Before matching, the engine normalizes the host header:

- Trailing port (`:8080`) is stripped.
- Trailing slash, if any, is stripped.
- The whole string is lowercased (Host headers are case-insensitive
  per RFC 7230 §5.4).

So `3000.FBI.COM:8080/` is treated identically to `3000.fbi.com`.

## Order semantics

Rules are evaluated top-to-bottom. The first one whose `match`
pattern fits the (normalized) host wins. There is no scoring, no
specificity ranking — purely first-match.

### Debugging

When the proxy doesn't route the way you expect, the usual culprits
are:

- **Wrong order.** A broader rule above a narrower one shadows it.
  Move the specific rule up.
- **`{domain}` ambiguity.** Patterns without `{domain}` consume the
  whole host. If you use `{host}.{domain}` against `a.b.c.fbi.com`,
  `{host}` captures `a` and `{domain}` greedily eats `b.c.fbi.com`.
  Whether that's what you want depends on your setup.
- **Domain filter mismatch.** If you started fbi-proxy with
  `--domain fbi.com`, any host that doesn't end with `.fbi.com` is
  rejected before rules even run.

In a future release the engine will log which rule fired (and which
ones were tried first) at debug level.

## Custom rules

Add your own rules to `routes.yaml`. Some examples:

### PR preview environments

```yaml
- name: pr-preview
  match: "pr-{id:int}.{domain}"
  target: "preview-{id}.internal:80"
  headers:
    Host: "pr-{id}.team.example.com"
```

`pr-42.fbi.com` &rarr; `preview-42.internal:80` with
`Host: pr-42.team.example.com`.

### Staging vs. production

```yaml
- name: staging
  match: "staging-{service:slug}.{domain}"
  target: "{service}.staging.svc:80"
  headers:
    Host: "{service}.staging.svc"

- name: production
  match: "{service:slug}.{domain}"
  target: "{service}.prod.svc:80"
  headers:
    Host: "{service}.prod.svc"
```

### Adding a forwarded-for header

```yaml
- name: app-with-trace
  match: "{app}.{domain}"
  target: "{app}:80"
  headers:
    Host: "{app}"
    X-Forwarded-For-Origin: "{app}.{domain}"
```

(Headers other than `Host` are added to the upstream request as
additional metadata — they don't change routing.)

### Catch-all for an internal namespace

```yaml
- name: internal
  match: "{name}.internal.{domain}"
  target: "{name}.svc.internal:80"
  headers:
    Host: "{name}.svc.internal"
```

### Docker network: service-name routing

If your fbi-proxy container shares a Docker network with other services,
their names already resolve. `service.docker.fbi.com` → `service:80`:

```yaml
- name: docker
  match: "{service}.docker.{domain}"
  target: "{service}:80"
  headers:
    Host: "{service}"
```

Use Docker Compose's `networks:` to put everything on the same bridge, or
`docker run --network=...`. Then `https://api.docker.fbi.com/` reaches the
`api` container's port 80.

### Kubernetes: in-cluster service routing

If fbi-proxy runs inside the cluster, k8s DNS gives you names like
`nginx.default.svc.cluster.local`. Bridge that to a human-friendly
subdomain:

```yaml
- name: k8s
  match: "{service:slug}.{namespace:slug}.k8s.{domain}"
  target: "{service}.{namespace}.svc.cluster.local:80"
  headers:
    Host: "{service}.{namespace}.svc.cluster.local"
```

`https://nginx.default.k8s.fbi.com/` → `nginx.default.svc.cluster.local:80`.

### DNS passthrough — fbi.com as a transparent overlay

The `{name:multi}` placeholder makes `*.fbi.com` behave like a
**suffix-stripping reverse proxy**: the public DNS for `*.fbi.com`
already points at your laptop (or your fbi-proxy host), so embedding any
real hostname as a sub-domain reaches that hostname after fbi-proxy
strips the trailing `.fbi.com` and re-resolves the prefix.

```yaml
- name: dns-passthrough
  match: "{upstream:multi}.{domain}"
  target: "{upstream}:80"
  headers:
    Host: "{upstream}"
```

What it does:

- `https://github.com.fbi.com/repo` &rarr; the proxy resolves `github.com`
  via the OS resolver and forwards to `github.com:80/repo` with
  `Host: github.com`.
- `https://api.example.org.fbi.com/v2/` &rarr; resolves `api.example.org`
  and forwards similarly.

Why this is useful:

- **Local-DNS overlay that looks like the real internet.** You don't
  need `/etc/hosts` or a custom DNS server to make external sites
  pretend to live under your dev domain — just embed them as subdomains.
- **Cookie sharing across the dev domain.** A page served from
  `github.com.fbi.com` is technically in the `.fbi.com` cookie space, so
  SSO sessions (from fbi-auth) automatically attach. Useful for testing
  what an authenticated user would see on a third-party site.
- **Sniffing / debugging.** All traffic goes through your fbi-proxy
  process, where you can log it or inject headers.

**HTTPS upstreams (R5, shipped):** prefix the target with `https://` to
make fbi-proxy speak TLS to the upstream. TLS verification uses the
Mozilla webpki roots (same trust store as Firefox); no cert pinning,
no skip-verify flag. Example:

```yaml
- name: github-passthrough
  match: "github.com.{domain}"
  target: "https://api.github.com:443"
  headers:
    Host: "api.github.com"
```

The `https://` prefix flips to `wss://` automatically for WebSocket
upgrade requests. Targets without a scheme prefix (the default form,
`host:port`) continue to use plain HTTP for backward compatibility.

⚠️ **Ordering matters.** Place `dns-passthrough` **after** more specific
rules in `routes.yaml`, otherwise `{upstream:multi}` greedily eats
patterns like `3000.fbi.com` (matching `upstream=3000` instead of
hitting `port-as-host`). The default 4 rules should remain at the top
unless you intentionally want the passthrough to win.

## Migrating from the hardcoded behavior

**You don't need to do anything.** When the engine is wired in, the
default `routes.yaml` will reproduce every branch of the old
`parse_host` function exactly. The mapping is:

| Old branch (rs/fbi-proxy.rs)              | New rule                |
| ----------------------------------------- | ----------------------- |
| Rule 1: number host &rarr; local port     | `port-as-host`          |
| Rule 1.2: `host--port` &rarr; `host:port` | `host-double-dash-port` |
| Rule 3: subdomain hoisting                | `subdomain-hoisting`    |
| Rule 2: bare host &rarr; `host:80`        | `direct-forward`        |

If you previously relied on undocumented edge cases (e.g. setting the
`Host` header to a value you can detect on the upstream), check
those still behave the way you expect — but the four documented
behaviors above are pixel-identical.

To customize, copy `routes.yaml` to a writable location and pass it
via the `--routes` flag (coming in a future release; until then the
defaults are the only path).

## Reference

- Source: `rs/routes.rs` (Rust engine, ~24 unit tests).
- TypeScript types & validator: `ts/routes.ts`, tested in
  `ts/routes.test.ts`.
- Original parser this replaces: `rs/fbi-proxy.rs::parse_host`.
