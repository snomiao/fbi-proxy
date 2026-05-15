//! Library entry point for `fbi-proxy`.
//!
//! This file exists primarily so that internal modules (like `routes`)
//! can be unit-tested via `cargo test --lib` without coupling them to
//! the binary's runtime concerns.
//!
//! The binary in `rs/fbi-proxy.rs` does not currently depend on this
//! library — the routing engine is intentionally not wired into the
//! live request path yet (see `docs/routing.md` for the migration
//! plan).

pub mod routes;
