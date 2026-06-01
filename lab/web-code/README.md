# web-code lab

A **github.com → fbi.com gateway**: swap the host on any GitHub URL and it
opens that repo in a browser VS Code, auto-provisioning the local checkout.
Everything runs under **one origin** (`https://fbi.com`) so VS Code embeds in
an `<iframe>` with no cross-origin friction.

```
github.com/<owner>/<repo>/tree/<branch>     (just change the host)
    ↓
https://fbi.com/<owner>/<repo>/tree/<branch>
    │  shell calls GET /api/repo/<owner>/<repo>/tree/<branch>
    │    • missing  -> git clone --branch <branch> --single-branch
    │                  into ~/ws/<owner>/<repo>/tree/<branch>
    │    • present  -> git fetch --prune; git pull --ff-only ONLY if the
    │                  worktree is clean & fast-forwardable (else fetch-only)
    │  -> returns the local folder + git status (ahead/behind/dirty)
    ↓
https://fbi.com/_vscode/?folder=<local worktree>   -> code serve-web (:9999)
```

### UI selector: `?ui=`

Append `?ui=wtx` to open a **web terminal** in the same worktree instead of
the editor (`?ui=vscode` or no param = VS Code):

```
https://fbi.com/<owner>/<repo>/tree/<branch>          -> VS Code  (default)
https://fbi.com/<owner>/<repo>/tree/<branch>?ui=wtx   -> terminal (wtx)
```

The terminal is [`@snomiao/wtx`](https://github.com/snomiao/wtx) — a Bun PTY
WebSocket server (vendored as a git submodule at `lib/wtx`) with its
`wtx-react` xterm.js UI. The shell hands off to `terminal.html`, which
provisions the repo via the same `/api/repo` endpoint, then opens a PTY at
that folder over `wss://fbi.com/_wtx/` (a third fbi-proxy route → :3004).

This is the motivating use case for fbi-proxy's runtime, path-aware routing:
two rules for the **same host** differing only by **path prefix**, registered
live via the admin API.

## How it works

- `fbi-proxy.yaml` declares the namespace `web-code` and two routes.
  `/_vscode/` wins over `/` because the router picks the **longest matching
  path prefix**. `/api/` and `/__config` ride the `/` route — no extra rule.
- `start.ts` launches `code serve-web` + the vite shell, then runs
  `fbi-proxy up` to register the routes (and `fbi-proxy down` on exit).
- `provision.ts` maps `<owner>/<repo>/tree/<branch>` to
  `~/ws/<owner>/<repo>/tree/<branch>`, clones/fetches/pulls as above, and
  reports git status. Every path segment is validated (no traversal, no git
  option injection) and git runs via `execFile` (no shell).
- `vite.config.ts` serves `/__config` and the `/api/repo/...` provisioning
  endpoint on the shell server.
- `shell.ts` reads `location.pathname`, calls the API, shows clone/fetch/pull
  status inline, then points the iframe at the folder the server returns.

## API

```
GET /api/repo/<owner>/<repo>/tree/<branch>
  -> { ok, folder, existed, action: cloned|pulled|fetched|none|error,
       git: { branch, head, ahead, behind, dirty, hasUpstream } }
```

`pull` happens only when the worktree is clean, has an upstream, is behind,
and is not ahead — local work is never clobbered; everything else is
fetch-only so you can merge/rebase yourself in the editor.

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
