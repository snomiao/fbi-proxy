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
    │                  --recurse-submodules into ~/ws/<owner>/<repo>/tree/<branch>
    │    • present  -> git fetch --prune; git pull --ff-only ONLY if the
    │                  worktree is clean & fast-forwardable (else fetch-only)
    │  then, on a clone / branch-create / fast-forward pull:
    │    • seed .env.local from the sibling tree/main worktree (non-main only)
    │    • run setup-repo.sh (Bun Shell): submodules + install deps
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
  `~/ws/<owner>/<repo>/tree/<branch>`, clones/fetches/pulls as above, then
  auto-sets-up the worktree (see below), and reports git status. Every path
  segment is validated (no traversal, no git option injection) and git runs
  via `execFile` (no shell).
- `setup-repo.sh` is the cross-platform setup script (see below).
- `vite.config.ts` serves `/__config` and the `/api/repo/...` provisioning
  endpoint on the shell server.
- `shell.ts` reads `location.pathname`, calls the API, shows clone/fetch/pull
  status inline, then points the iframe at the folder the server returns.

## Auto-setup

A freshly provisioned worktree is left **ready to use** — no manual install:

- **Submodules** — clones recurse them (`--recurse-submodules`).
- **`.env.local`** — for any non-`main` branch, seeded from the sibling
  `tree/main` worktree (seed-once: never overwrites the branch's own), so
  feature checkouts inherit local, gitignored env without re-entry.
- **Dependencies** — `setup-repo.sh` runs via **Bun Shell**
  (`bun setup-repo.sh`), so it works identically on macOS/Linux/Windows
  without a real `sh`. It updates submodules and installs deps for whichever
  ecosystem(s) the repo uses, matching the committed lockfile/manifest:
  - JS/TS — `bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
    `package-lock.json` → npm (else bun for a bare `package.json`)
  - Rust (`Cargo.toml` → `cargo fetch`), Go (`go.mod` → `go mod download`),
    Python (`uv.lock`/`poetry.lock`/`Pipfile.lock`/`requirements.txt`),
    Ruby (`Gemfile.lock` → `bundle install`)
  - Each step is `|| true` — a missing toolchain or one ecosystem's hiccup
    never aborts the rest, and the editor still opens.

Setup runs only when the checkout changes — on a **clone**, **branch
creation**, or a **fast-forward pull**. Opens that fetch nothing new skip it
(submodules and installs only change with the checkout), so repeat opens of an
existing worktree stay fast even for repos with many submodules.

To re-run setup by hand from a worktree: `bun /path/to/lab/web-code/setup-repo.sh`.

## API

```
GET  /api/repo/<owner>/<repo>/tree/<branch>            (provision)
POST /api/repo/<owner>/<repo>/tree/<branch>?create=1  (create branch off main)
  -> { ok, folder, existed, action: cloned|created|pulled|fetched|none|error,
       git: { branch, head, ahead, behind, dirty, hasUpstream } }
```

`pull` happens only when the worktree is clean, has an upstream, is behind,
and is not ahead — local work is never clobbered; everything else is
fetch-only so you can merge/rebase yourself in the editor.

## Prerequisites

1. **A running fbi-proxy with TLS termination** (path routing needs the proxy
   to terminate TLS — in CONNECT forward-proxy mode only host/SNI is visible).
   - **macOS** — one command sets up the daemon, a system-trusted cert, and a
     `pf` redirect from `:443`:
     ```sh
     fbi-proxy setup --domain fbi.com
     ```
   - **Windows / Linux** — `setup` is macOS-only; run the proxy directly. Use
     a port you can bind without elevation (e.g. `8443`), or `443` with
     admin/root. The cert is self-signed (browser warning unless you trust it):
     ```sh
     fbi-proxy --tls --domain fbi.com --port 8443
     ```

2. **Point `fbi.com` at loopback** by adding a hosts entry (`127.0.0.1 fbi.com`):
   - macOS / Linux: `/etc/hosts`
   - Windows: `%SystemRoot%\System32\drivers\etc\hosts` (edit as Administrator)

3. **The `code` CLI on PATH** (VS Code → "Shell Command: Install 'code' command").

## Run

The launcher reads `./fbi-proxy.yaml` and resolves its config relative to this
directory, so run it **from this folder** (it has its own `package.json`):

```sh
cd lab/web-code
bun install        # vite + react + xterm (separate from the repo root install)
bun run dev        # = bun run start.ts
```

`start.ts` spawns `code serve-web` (:9999), the vite shell (:3001), and the wtx
PTY server (:3004), then runs `fbi-proxy up` to register the routes (and
`fbi-proxy down` on exit). It assumes the proxy from step 1 is already running.

### Run as a managed daemon (oxmgr)

To keep the lab running in the background — auto-restarting on crash and
restored at boot — register it under [oxmgr](https://github.com/oxmgr) (the same
process manager `fbi-proxy setup` uses for the proxy):

```sh
cd lab/web-code
bun run daemon         # register + start "web-code-lab", persist across reboots
bun run daemon:status  # oxmgr status web-code-lab
bun run daemon:logs    # oxmgr logs   web-code-lab
bun run daemon:stop    # stop + remove the managed process
```

This wraps the same `start.ts` launcher as **one** oxmgr process, so its three
child servers and the `fbi-proxy up`/`down` lifecycle stay intact. The launcher
**retries `fbi-proxy up` until the proxy answers**, so it doesn't matter whether
oxmgr restores this lab or the `fbi-proxy` daemon first at boot. Don't run
`bun run dev` and the daemon at the same time — they bind the same fixed ports
(`--strictPort` makes vite crash on a conflict, which oxmgr would then
crash-loop).

Then open `https://fbi.com/<owner>/<repo>/tree/<branch>` — the shell loads and
embeds VS Code opened at the local worktree under `~/ws/...` (`%USERPROFILE%\ws\...`
on Windows). Append `?ui=wtx` for the terminal instead.

> If you bound the proxy to a non-standard port in step 1 (e.g. `8443`), the
> URL is `https://fbi.com:8443/...`.

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
