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

Then open `https://fbi.com/<user>/<repo>/tree/<branch>` — the shell loads and
embeds VS Code opened at `~/ws/<user>/<repo>/tree/<branch>`.

## Manual rule management

```sh
fbi-proxy up        # apply ./fbi-proxy.yaml  (namespace from `name:`)
fbi-proxy ps        # list all active rules across namespaces
fbi-proxy down      # remove this namespace's rules
```

## Gotchas hit while getting VS Code to render behind the proxy

Bringing serve-web up under `https://fbi.com` surfaced several issues. For
the record, what was actually **load-bearing** vs incidental:

- **WebSocket `permessage-deflate` (the real blocker).** serve-web's
  management socket negotiates deflate with the browser. The proxy must NOT
  forward `Sec-WebSocket-Extensions` to its own upstream socket, or upstream
  frames arrive with the RSV1 bit set and tungstenite drops the connection
  ("Reserved bits are non-zero") right after the 101 — workbench mounts but
  the file tree never loads. Fixed in `rs/fbi-proxy.rs`.
- **NLS locale (load-bearing on a non-English OS).** On a `ja_JP` machine VS
  Code fetches `…/ja/nls.messages.js` from `vscode-unpkg.net`, which is
  CORS-blocked from the `fbi.com` origin (and version-mismatched even on
  127.0.0.1, showing `{0}` placeholders). `shell.ts` pins
  `vscode.nls.locale=en` (localStorage + cookie) to use the built-in English.
- **`Host: fbi.com` forward (NOT load-bearing).** Kept because it makes
  `remoteAuthority` match the public host, but the editor works without it.
- **Stale browser state.** A profile that previously hit a broken/older
  serve-web caches a dead workbench; clear site data for the origin if the
  tree is stubbornly empty after the above are fixed.
