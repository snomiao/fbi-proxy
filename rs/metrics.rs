//! Simple Prometheus-text metrics for fbi-proxy.
//!
//! Tiny counter set, no external prom_client dep — `fmt::Write` is
//! enough. The counters are atomic so they can be incremented from any
//! request task without locks; the renderer reads them with `Ordering::
//! Relaxed` (monotonic counters, dirty reads are fine).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct Metrics {
    pub requests_total: AtomicU64,
    pub status_2xx_total: AtomicU64,
    pub status_3xx_total: AtomicU64,
    pub status_4xx_total: AtomicU64,
    pub status_5xx_total: AtomicU64,
    pub upstream_connect_failures_total: AtomicU64,
    pub upstream_timeouts_total: AtomicU64,
    pub websocket_upgrades_total: AtomicU64,
    pub host_rejected_total: AtomicU64,
}

impl Metrics {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn record_status(&self, status: u16) {
        self.requests_total.fetch_add(1, Ordering::Relaxed);
        let bucket = match status {
            200..=299 => &self.status_2xx_total,
            300..=399 => &self.status_3xx_total,
            400..=499 => &self.status_4xx_total,
            500..=599 => &self.status_5xx_total,
            _ => return, // other status codes (1xx, etc.) — ignore for now
        };
        bucket.fetch_add(1, Ordering::Relaxed);
    }

    pub fn render_prometheus(&self) -> String {
        let mut out = String::with_capacity(1024);
        emit_counter(&mut out, "fbi_proxy_requests_total",
            "Total HTTP requests handled by fbi-proxy.",
            self.requests_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_status_2xx_total",
            "HTTP responses with status 2xx.",
            self.status_2xx_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_status_3xx_total",
            "HTTP responses with status 3xx.",
            self.status_3xx_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_status_4xx_total",
            "HTTP responses with status 4xx.",
            self.status_4xx_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_status_5xx_total",
            "HTTP responses with status 5xx.",
            self.status_5xx_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_upstream_connect_failures_total",
            "Failed TCP/TLS connects to upstream.",
            self.upstream_connect_failures_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_upstream_timeouts_total",
            "Upstream requests that exceeded the request timeout.",
            self.upstream_timeouts_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_websocket_upgrades_total",
            "WebSocket upgrade requests handled.",
            self.websocket_upgrades_total.load(Ordering::Relaxed));
        emit_counter(&mut out, "fbi_proxy_host_rejected_total",
            "Requests rejected because the Host header didn't match the domain filter or any route.",
            self.host_rejected_total.load(Ordering::Relaxed));
        out
    }
}

fn emit_counter(out: &mut String, name: &str, help: &str, value: u64) {
    use std::fmt::Write;
    let _ = writeln!(out, "# HELP {} {}", name, help);
    let _ = writeln!(out, "# TYPE {} counter", name);
    let _ = writeln!(out, "{} {}", name, value);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_status_routes_to_correct_bucket() {
        let m = Metrics::new();
        m.record_status(200);
        m.record_status(204);
        m.record_status(302);
        m.record_status(404);
        m.record_status(502);
        m.record_status(502);
        assert_eq!(m.requests_total.load(Ordering::Relaxed), 6);
        assert_eq!(m.status_2xx_total.load(Ordering::Relaxed), 2);
        assert_eq!(m.status_3xx_total.load(Ordering::Relaxed), 1);
        assert_eq!(m.status_4xx_total.load(Ordering::Relaxed), 1);
        assert_eq!(m.status_5xx_total.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn render_includes_help_and_type_lines() {
        let m = Metrics::new();
        m.record_status(200);
        let out = m.render_prometheus();
        assert!(out.contains("# HELP fbi_proxy_requests_total"));
        assert!(out.contains("# TYPE fbi_proxy_requests_total counter"));
        assert!(out.contains("fbi_proxy_requests_total 1\n"));
        assert!(out.contains("fbi_proxy_status_2xx_total 1\n"));
    }
}
