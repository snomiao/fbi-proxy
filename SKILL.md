---
name: fbi-proxy
description: Expose local dev servers over HTTPS with fbi-proxy — `*.fbi.com` host-routed proxy and the tailscale-serve-style `fbi-proxy serve <host> <target>`. Use when giving a localhost port an https URL, or when setting it up next to `tailscale serve` on :443.
---

# fbi-proxy

Every `*.fbi.com` name resolves to `127.0.0.1`, so fbi-proxy gives local services HTTPS names without editing DNS or hosts files.

## `serve`: one route per command

```sh
bunx fbi-proxy serve myapp 3000                        # https://myapp.fbi.com → localhost:3000 (foreground)
bunx fbi-proxy serve --bg docs http://127.0.0.1:4000   # persistent
bunx fbi-proxy serve up https+insecure://localhost:8443
bunx fbi-proxy serve myapp off | status | reset
```

- Runs its own managed Caddy (admin `127.0.0.1:2430`, `FBI_SERVE_ADMIN`) with a local-CA cert. It has no `:80` listener.
- Routes are stored in `~/.config/fbi-proxy/serve.json`. Caddy stops when the last route is removed.
- It refuses to start if something already answers on `127.0.0.1:443`; use `--https 8443` (sticky) instead.
- Use `--rewrite-host` for dev servers that check `Host`, such as Vite `allowedHosts`.

## Coexisting with `tailscale serve`

They don't conflict on `:443`, because each binds a different address:

- `fbi-proxy serve` binds `127.0.0.1:443` and serves `*.fbi.com` on **this machine only**.
- `tailscale serve` binds only the tailnet IP (`100.x:443`) and serves `<machine>.<tailnet>.ts.net` to **tailnet peers**.

Rules for agents:

1. Keep the default `--bind 127.0.0.1`. Don't use `0.0.0.0`: it exposes Caddy on the LAN, and when tailscale serve is off, tailnet peers get a `*.fbi.com` cert that doesn't match.
2. To share a port on the tailnet, point tailscale serve straight at it: `tailscale serve --bg --set-path /app http://127.0.0.1:3000`. Don't give peers an `fbi.com` URL, because it resolves to their own loopback.
3. Don't put tailscale serve in front of the host-routed Rust proxy. The upstream sees `Host: <machine>.ts.net`, which matches no route.
4. Verified on Windows, where tailscaled binds `100.x:443` and fbi-proxy's `127.0.0.1:443` and `0.0.0.0:443` binds both succeed with traffic split by destination. The macOS pf redirect is `lo0`-only. Linux tailscaled usually uses netstack (not tested).

## Shell gotcha on Windows

In Git Bash, redirect to `/dev/null`, not `NUL`. `> NUL` creates a real file named `NUL` in the working directory.
