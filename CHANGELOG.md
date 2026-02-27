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
