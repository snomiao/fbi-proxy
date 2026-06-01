# [1.17.0](https://github.com/snomiao/fbi-proxy/compare/v1.16.0...v1.17.0) (2026-06-01)

### Bug Fixes

- **lab/web-code:** forward public Host to serve-web so the file tree loads ([1bb2d07](https://github.com/snomiao/fbi-proxy/commit/1bb2d072f407ebd2d19c34891feb6d32012c486b))
- **lab/web-code:** pin VS Code locale via cookie so the editor renders ([647253a](https://github.com/snomiao/fbi-proxy/commit/647253a519619781c444cc4e7fbab0e364d97e39))
- **proxy:** don't forward WS extensions upstream — fixes VS Code file tree ([5de7e76](https://github.com/snomiao/fbi-proxy/commit/5de7e76371a32183e8c3bcd58a365359a5ff03b1))
- **proxy:** forward WebSocket headers so VS Code serve-web works behind the proxy ([5c25a9d](https://github.com/snomiao/fbi-proxy/commit/5c25a9d6c8b3e6d8ea8c862abaa0371d464cd095))
- **setup:** explain why macOS asks for a password; harden web-code lab ([003b234](https://github.com/snomiao/fbi-proxy/commit/003b234fa0dee578e68ebda9204540142b850856))

### Features

- **routes:** runtime per-project rules via compose-style CLI + path matching ([e350dad](https://github.com/snomiao/fbi-proxy/commit/e350dad12e7b5214ebfb1484aa66b21f34deba0c))

# [1.16.0](https://github.com/snomiao/fbi-proxy/compare/v1.15.0...v1.16.0) (2026-05-19)

### Features

- **auth:** add 'local' provider — username/password, no network ([7f02fb9](https://github.com/snomiao/fbi-proxy/commit/7f02fb9d79d3a56769a5eb3db177f7bcb84e2fe5))
- ship `fbi-proxy setup` — daemon + trusted cert + pf :443→:8443 ([eec5f5a](https://github.com/snomiao/fbi-proxy/commit/eec5f5af41be26927353d20a647cbe2e89ef7068))

# [1.15.0](https://github.com/snomiao/fbi-proxy/compare/v1.14.0...v1.15.0) (2026-05-18)

### Features

- **metrics:** Prometheus counters on a 127.0.0.1 admin port ([c60b956](https://github.com/snomiao/fbi-proxy/commit/c60b9568aa593e3215eb740d9c5cb9e6217ecbcc))

# [1.14.0](https://github.com/snomiao/fbi-proxy/compare/v1.13.0...v1.14.0) (2026-05-18)

### Features

- **routing:** hot reload — watch routes.yaml, swap atomically ([d9372c7](https://github.com/snomiao/fbi-proxy/commit/d9372c7b811b88eaac2d25545c5b9a156fe52f92))

# [1.13.0](https://github.com/snomiao/fbi-proxy/compare/v1.12.0...v1.13.0) (2026-05-18)

### Features

- **wizard,docs:** custom-domain DNS/TLS hints + README sync ([861c64c](https://github.com/snomiao/fbi-proxy/commit/861c64cbfa8c299e404674b6ae992244b04ad1dc))

# [1.12.0](https://github.com/snomiao/fbi-proxy/compare/v1.11.0...v1.12.0) (2026-05-18)

### Features

- **routing:** R5 — HTTPS upstream support via hyper-rustls ([b94b9f7](https://github.com/snomiao/fbi-proxy/commit/b94b9f7c35f8f65b4599ad2813a703e3c1bbe1ce))

# [1.11.0](https://github.com/snomiao/fbi-proxy/compare/v1.10.1...v1.11.0) (2026-05-18)

### Features

- **auth:** Phase 5 — audit log, configurable refresh, reconfigure polish ([b1eadf8](https://github.com/snomiao/fbi-proxy/commit/b1eadf8d1505d8fafa4138625f7aaf953542304f))

## [1.10.1](https://github.com/snomiao/fbi-proxy/compare/v1.10.0...v1.10.1) (2026-05-18)

### Bug Fixes

- **tests:** green up four flaky/stale assertions ([a8a3b17](https://github.com/snomiao/fbi-proxy/commit/a8a3b17944c3926710f8f8a94e2d681b9fc1b0d5))

# [1.10.0](https://github.com/snomiao/fbi-proxy/compare/v1.9.1...v1.10.0) (2026-05-18)

### Features

- **auth:** add fbi-auth OAuth2 gateway (Phase 1 MVP — Google) ([513f358](https://github.com/snomiao/fbi-proxy/commit/513f358efb445c5dfd65f43da9e86da4e47daf0e))
- **auth:** Phase 2 — Firebase provider + setup wizard ([638bf8c](https://github.com/snomiao/fbi-proxy/commit/638bf8c4028bac861560ad034bc74c5a380ca621))
- **auth:** Phase 3 — --with-caddy automation ([0fd8dad](https://github.com/snomiao/fbi-proxy/commit/0fd8dad61c4abcf8ab1d4a49c39a5acf532ea02f))
- **auth:** Phase 3.1 — auto-download Caddy from GitHub Releases ([d9dccb8](https://github.com/snomiao/fbi-proxy/commit/d9dccb82ce9be4455943d7bf708d3255a03526eb))
- **auth:** Phase 4 — snolab default IdP infrastructure ([c58b2b0](https://github.com/snomiao/fbi-proxy/commit/c58b2b0a2b2a1da4e7dd41b6e1f0dcb77c82514d))
- **auth:** Phase 4 — snolab default IdP via Firebase (working end-to-end) ([f3eb56e](https://github.com/snomiao/fbi-proxy/commit/f3eb56e9ee6d7c71217a724982233bb0e03819d0))
- **routing:** add {name:multi} placeholder + Docker/k8s/DNS-passthrough recipes ([3968803](https://github.com/snomiao/fbi-proxy/commit/3968803d6ed2eb8a7d508fb9dcbd3f2bc1fd802b))
- **routing:** R3 — wire engine into the live Rust binary ([09ed817](https://github.com/snomiao/fbi-proxy/commit/09ed81716f8831ce2415df9d7dcade48d851b6d7))
- **routing:** rule-based placeholder matcher engine (R1+R2) ([3514caf](https://github.com/snomiao/fbi-proxy/commit/3514cafb127d33dd0a72424bdbe6433ff45fd8ce))

## [1.9.1](https://github.com/snomiao/fbi-proxy/compare/v1.9.0...v1.9.1) (2026-03-22)

### Bug Fixes

- show descriptive 502 Bad Gateway errors instead of opaque FBIPROXY ERROR ([7bf1188](https://github.com/snomiao/fbi-proxy/commit/7bf11883fae39b71c9a14472fdcfeb8e2d89f02b))

# [1.9.0](https://github.com/snomiao/fbi-proxy/compare/v1.8.1...v1.9.0) (2026-03-01)

### Features

- add startup tutorial and landing page for root domain ([7af423c](https://github.com/snomiao/fbi-proxy/commit/7af423c82f0f397364e05312125b73097a426304))

## [1.8.1](https://github.com/snomiao/fbi-proxy/compare/v1.8.0...v1.8.1) (2026-02-27)

### Bug Fixes

- **release:** use explicit binary names instead of generic label ([779077d](https://github.com/snomiao/fbi-proxy/commit/779077d000f6a9962ae5ddd48868e3e14bdabda9))

# [1.8.0](https://github.com/snomiao/fbi-proxy/compare/v1.7.0...v1.8.0) (2026-02-27)

### Bug Fixes

- add 3s timeout for upstream connections to prevent hanging ([14f5fe4](https://github.com/snomiao/fbi-proxy/commit/14f5fe4228b097d449d94ad3d47e5cd28b5830e8))
- force @semantic-release/npm v13 via overrides to enable OIDC ([108fa57](https://github.com/snomiao/fbi-proxy/commit/108fa574192b7742e656b2daab6934dc3b472dc3))
- improve e2e test stability and fix websocket error handling ([#5](https://github.com/snomiao/fbi-proxy/issues/5)) ([e1f6953](https://github.com/snomiao/fbi-proxy/commit/e1f6953471af01d65b8e8f477dfa9e0968739b28))
- resolve TypeScript compilation errors in e2e tests ([dd08089](https://github.com/snomiao/fbi-proxy/commit/dd08089368dfe98f6f0409460f0459419fdcbb86))
- update package dependencies and remove package-lock.json ([b380d92](https://github.com/snomiao/fbi-proxy/commit/b380d92447c3c561595f05d948ba17c6fbaa68d1))
- update release workflow to remove pull_request trigger and setup node ([8cbc0dd](https://github.com/snomiao/fbi-proxy/commit/8cbc0ddb08a8d9832762f6c5c157f2c3fd377608))
- upgrade to semantic-release v24 and @semantic-release/npm v13 for OIDC support ([216f31b](https://github.com/snomiao/fbi-proxy/commit/216f31b32ce40af3469e3e706151d4c483e9cf39))

### Features

- add vitest testing framework and e2e tests ([cc91fc1](https://github.com/snomiao/fbi-proxy/commit/cc91fc1373367e6313f0943ddbabd2af190bf594))
- add VSCode Web e2e test through proxy ([#6](https://github.com/snomiao/fbi-proxy/issues/6)) ([b5fd27d](https://github.com/snomiao/fbi-proxy/commit/b5fd27df3108bc2ba320f2857e822166a444c3bf))
- enable TypeScript CLI wrapper e2e tests ([0bbcb23](https://github.com/snomiao/fbi-proxy/commit/0bbcb2330860202e667e55ec890984b3421063cf))
- **releaserc:** enable provenance tracking for npm packages to enhance security and compliance ([04fbc99](https://github.com/snomiao/fbi-proxy/commit/04fbc994cfb1ff41af4a8e9842441485afa09081))

# [1.7.0](https://github.com/snomiao/fbi-proxy/compare/v1.6.2...v1.7.0) (2025-09-16)

### Features

- upgrade Rust dependencies to latest versions ([7ce71b2](https://github.com/snomiao/fbi-proxy/commit/7ce71b2563d3762c8d5b4c13a98a22761e6b35a2))

## [1.6.2](https://github.com/snomiao/fbi-proxy/compare/v1.6.1...v1.6.2) (2025-09-15)

### Bug Fixes

- preserve gzip compression between upstream and downstream ([d44369e](https://github.com/snomiao/fbi-proxy/commit/d44369e0b8ebcfd452950df289ef09f11259ff68))

## [1.6.1](https://github.com/snomiao/fbi-proxy/compare/v1.6.0...v1.6.1) (2025-09-13)

### Bug Fixes

- **cli.ts:** update process.chdir to use import.meta.dir for better compatibility with ES modules ([a747d1b](https://github.com/snomiao/fbi-proxy/commit/a747d1b545be865deafc7a888642974e622d2526))

# [1.6.0](https://github.com/snomiao/fbi-proxy/compare/v1.5.0...v1.6.0) (2025-09-12)

### Bug Fixes

- pkg ts ([4701744](https://github.com/snomiao/fbi-proxy/commit/4701744a0eb64d46bd5c9b589569c7cabc9dc9a4))

### Features

- **proxy:** add domain filtering and comprehensive request logging ([683e235](https://github.com/snomiao/fbi-proxy/commit/683e23524330459e310123708596575b7843fefe))

# [1.5.0](https://github.com/snomiao/fbi-proxy/compare/v1.4.0...v1.5.0) (2025-08-10)

### Features

- **Cargo.toml:** add clap dependency for command-line argument parsing to enhance user experience ([d7461f6](https://github.com/snomiao/fbi-proxy/commit/d7461f6926d252aa7c3a6121721964be76648e99))

# [1.4.0](https://github.com/snomiao/fbi-proxy/compare/v1.3.0...v1.4.0) (2025-07-30)

### Features

- **package.json:** add start:js script to run the compiled JavaScript file ([9090937](https://github.com/snomiao/fbi-proxy/commit/909093789d713bb3e5f65b222461638e398f7dd0))

# [1.3.0](https://github.com/snomiao/fbi-proxy/compare/v1.2.0...v1.3.0) (2025-07-30)

### Features

- **package.json:** update build scripts to improve build process and add support for Rust binary ([29786b7](https://github.com/snomiao/fbi-proxy/commit/29786b77cc9b325fcd3f18cd6de0b73ca5c6fddb))

# [1.2.0](https://github.com/snomiao/fbi-proxy/compare/v1.1.0...v1.2.0) (2025-07-26)

### Features

- add development tooling with husky, lint-staged, and prettier ([c223c22](https://github.com/snomiao/fbi-proxy/commit/c223c2257a040fc6fd561678af83ce506f971e39))

# [1.1.0](https://github.com/snomiao/fbi-proxy/compare/v1.0.0...v1.1.0) (2025-07-25)

### Features

- migrate from npm to bun in GitHub Actions workflow ([fe40560](https://github.com/snomiao/fbi-proxy/commit/fe405600af20f3268b1567399d2a3467f23d2337))

# 1.0.0 (2025-07-25)

### Bug Fixes

- **main:** dont ignore caddy ([74e1e8c](https://github.com/snomiao/fbi-proxy/commit/74e1e8c070e08ae31bac498f583f1807b8a20920))
- **main:** init bun ([9b7baed](https://github.com/snomiao/fbi-proxy/commit/9b7baedf1f80a55cc818f97099cc5c854fda0d9e))
- **main:** setup ([0a00110](https://github.com/snomiao/fbi-proxy/commit/0a00110e6ace713265b4dbf3980515e77663e8a0))

### Features

- add Caddyfile and CLI for proxy server setup with WebSocket support ([8ed37b0](https://github.com/snomiao/fbi-proxy/commit/8ed37b0652a33beae86b2b6c3881534c1bb9b1bc))
- migrate to semantic-release for automated releases ([b3a5f8a](https://github.com/snomiao/fbi-proxy/commit/b3a5f8a1e2cfc92d7e93a941d15acb43ce896d3f))
- proxy.rs now reads PROXY_PORT environment variable ([1616790](https://github.com/snomiao/fbi-proxy/commit/1616790c855d49f4f5c78b31022dca6caa6148f3))
- update Caddyfile to use FBIPROXY_PORT and enhance cli.ts with help options and improved proxy handling ([0de99ff](https://github.com/snomiao/fbi-proxy/commit/0de99ff4e1c0cd15be579ac98f4b19479c320210))
- update project configuration and dependencies ([ab9d8cf](https://github.com/snomiao/fbi-proxy/commit/ab9d8cfe7cfb200c57df915e7ab4ede3a7b0a703))
