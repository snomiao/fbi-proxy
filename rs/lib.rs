//! Library entry point for `fbi-proxy`.
//!
//! Exposes internal modules so they can be unit-tested via
//! `cargo test --lib` and reused by the binary in `rs/fbi-proxy.rs`.

pub mod metrics;
pub mod routes;
pub mod tls;
