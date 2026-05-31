# web-code lab

Serve a browser VS Code instance and a thin shell page under **one origin**
(`https://fbi.com`), so the shell can embed VS Code in an `<iframe>` with no
cross-origin friction.

```
https://fbi.com/                       -> vite shell (:3001)
https://fbi.com/<user>/<repo>/tree/<branch>
                                        -> shell rewrites the iframe to
https://fbi.com/_vscode/?folder=<home>/ws/<user>/<repo>/tree/<branch>
                                        -> code serve-web (:9999)
```

This is the motivating use case for fbi-proxy's runtime, path-aware routing:
two rules for the **same host** differing only by **path prefix**, registered
live via the admin API.

## How it works

- `fbi-proxy.yaml` declares the namespace `web-code` and two routes.
  `/_vscode/` wins over `/` because the router picks the **longest matching
  path prefix**.
- `start.ts` launches `code serve-web` + the vite shell, then runs
  `fbi-proxy up` to register the routes (and `fbi-proxy down` on exit).
- `vite.config.ts` exposes `/__config` with the server's `home` dir, so the
  client builds the correct `?folder=` path.
- `shell.ts` reads `location.pathname` and points the iframe at VS Code.

## Prerequisites

1. A running fbi-proxy daemon with TLS termination (so it can route on path):
   ```sh
   fbi-proxy setup --domain fbi.com      # daemon + trusted cert + pf :443
   ```
   Ensure `fbi.com` resolves to loopback:
   ```sh
   echo '127.0.0.1 fbi.com' | sudo tee -a /etc/hosts
   ```
2. The `code` CLI on PATH (VS Code → "Shell Command: Install 'code' command").

## Run

```sh
cd lab/web-code
bun install        # vite
bun run dev        # = bun run start.ts
```

Then open <https://fbi.com/snomiao/rechrome/tree/main> — the shell loads and
embeds VS Code opened at `~/ws/snomiao/rechrome/tree/main`.

## Manual rule management

```sh
fbi-proxy up        # apply ./fbi-proxy.yaml  (namespace from `name:`)
fbi-proxy ps        # list all active rules across namespaces
fbi-proxy down      # remove this namespace's rules
```
