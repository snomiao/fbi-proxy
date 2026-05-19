use clap::{Arg, Command};
use fbi_proxy::metrics::Metrics;
use fbi_proxy::routes::{self, CompiledRoute, RouteHit};
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, HOST};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Uri};
use hyper_tungstenite::{HyperWebsocket, WebSocketStream};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioIo;
use hyper_rustls::HttpsConnector;
use arc_swap::ArcSwap;
use log::{error, info, warn};
use regex::Regex;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio::io::copy_bidirectional;
use tokio_tungstenite::connect_async;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

/// Bundled default routes.yaml — reproduces the original `parse_host`
/// behavior. Loaded at compile-time so the binary works out-of-the-box.
const BUNDLED_ROUTES_YAML: &str = include_str!("../routes.yaml");

pub struct FBIProxy {
    client: Client<HttpsConnector<HttpConnector>, BoxBody>,
    number_regex: Regex,
    domain_filter: Option<String>,
    /// Compiled routes wrapped in an ArcSwap so they can be replaced
    /// atomically at runtime (hot reload from `--routes`). Reads use
    /// `.load()` and never block; writes are atomic Arc swaps.
    compiled_routes: Arc<ArcSwap<Vec<CompiledRoute>>>,
    metrics: Arc<Metrics>,
}

/*
FBIProxy is a simple HTTP and WebSocket proxy server with rule-based
host header routing. The rules are loaded from `routes.yaml` (bundled
by default, overridable via --routes). See the bundled `routes.yaml`
for the default 8 rules; in short:

rule1: number host goes to local port
    - Host="3000" => localhost:3000

rule1.2 host--port goes to host:port
    - Host="localhost--3000" => localhost:3000
    - Host="sur--3000" => sur:3000

rule2: other host goes to that host:80
    - localhost => proxy to http://localhost
    - amd => proxy to http://amd

rule3: subdomains are hoisted
    - 3000.localhost => proxies to http://localhost:80, with host: 3000
    - 3000.amd => proxies to http://amd:80, with host: 3000
    - sur.amd => proxies to http://amd:80, with host: sur
    - amd.sur.amd => proxies to http://amd:80, with host: amd.sur

When `--domain` (or `FBI_PROXY_DOMAIN`) is set, only hosts ending with
that suffix are accepted. The exact-domain host (e.g. `fbi.com`) serves
the landing page.
*/
impl FBIProxy {
    pub fn new(domain_filter: Option<String>, compiled_routes: Vec<CompiledRoute>) -> Self {
        let mut http = HttpConnector::new();
        // Connect timeout — avoid hanging on unreachable hosts.
        http.set_connect_timeout(Some(Duration::from_secs(3)));
        // Allow http:// scheme through the HTTPS-enabled connector below.
        http.enforce_http(false);

        // HttpsConnector handles both http:// and https:// upstream URLs,
        // using Mozilla's webpki root store for TLS validation.
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_or_http()
            .enable_http1()
            .wrap_connector(http);

        let client = Client::builder(hyper_util::rt::TokioExecutor::new()).build(https);

        Self {
            client,
            number_regex: Regex::new(r"^\d+$").unwrap(),
            domain_filter,
            compiled_routes: Arc::new(ArcSwap::from_pointee(compiled_routes)),
            metrics: Metrics::new(),
        }
    }

    /// Return a handle to the live routes Arc so callers (e.g. the
    /// file watcher) can swap them at runtime without re-creating the
    /// proxy.
    pub fn routes_handle(&self) -> Arc<ArcSwap<Vec<CompiledRoute>>> {
        Arc::clone(&self.compiled_routes)
    }

    /// Return a handle to the live metrics counters so the metrics
    /// admin endpoint can read them.
    pub fn metrics_handle(&self) -> Arc<Metrics> {
        Arc::clone(&self.metrics)
    }

    fn landing_page_html() -> String {
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FBI-Proxy</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
            background: #0d1117;
            color: #c9d1d9;
            line-height: 1.6;
        }
        h1 { color: #58a6ff; margin-bottom: 0.5rem; }
        h2 { color: #8b949e; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
        code {
            background: #161b22;
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            font-size: 0.9em;
        }
        pre {
            background: #161b22;
            padding: 1rem;
            border-radius: 8px;
            overflow-x: auto;
        }
        table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
        th, td {
            text-align: left;
            padding: 0.5rem;
            border-bottom: 1px solid #30363d;
        }
        th { color: #8b949e; }
        .arrow { color: #7ee787; }
        a { color: #58a6ff; }
        .warning {
            background: #3d1f00;
            border: 1px solid #f85149;
            padding: 1rem;
            border-radius: 8px;
            margin: 1rem 0;
        }
    </style>
</head>
<body>
    <h1>🔀 FBI-Proxy</h1>
    <p>A reverse proxy with intelligent host header routing.</p>

    <h2>How It Works</h2>
    <p>FBI-Proxy routes requests based on the <code>Host</code> header:</p>
    <table>
        <tr><th>Host Header</th><th></th><th>Routes To</th><th>Description</th></tr>
        <tr><td><code>3000</code></td><td class="arrow">→</td><td><code>localhost:3000</code></td><td>Port as host</td></tr>
        <tr><td><code>api--8080</code></td><td class="arrow">→</td><td><code>api:8080</code></td><td>host--port syntax</td></tr>
        <tr><td><code>3000.fbi.com</code></td><td class="arrow">→</td><td><code>localhost:3000</code></td><td>Subdomain as port</td></tr>
        <tr><td><code>app.server</code></td><td class="arrow">→</td><td><code>server:80</code></td><td>Subdomain hoisting</td></tr>
    </table>

    <h2>Quick Start</h2>
    <pre>npx fbi-proxy                     # Start proxy on :2432
npx fbi-proxy -d fbi.example.com  # Only accept *.fbi.example.com</pre>

    <h2>Caddy Setup</h2>
    <p>Expose local ports via HTTPS with wildcard domain:</p>
    <pre># Caddyfile
*.fbi.example.com {
    tls { dns cloudflare {env.CF_API_TOKEN} }
    reverse_proxy localhost:2432
}</pre>
    <p>Then access:</p>
    <ul>
        <li><code>https://3000.fbi.example.com</code> → <code>localhost:3000</code></li>
        <li><code>https://8080.fbi.example.com</code> → <code>localhost:8080</code></li>
    </ul>

    <div class="warning">
        ⚠️ <strong>Security Warning:</strong> Set up an auth gateway before exposing to the internet.
    </div>

    <p><a href="https://github.com/snomiao/fbi-proxy">GitHub</a> · <a href="https://www.npmjs.com/package/fbi-proxy">npm</a> · <a href="https://crates.io/crates/fbi-proxy">crates.io</a></p>
</body>
</html>"#.to_string()
    }

    /// Extract the hostname portion (before the first `:`) from a target
    /// string like `"127.0.0.1:3000"` or `"https://api.github.com:443"`.
    /// This is the default `Host` header value used when a matched rule
    /// doesn't specify an explicit `headers.Host` rewrite.
    fn host_from_target(target: &str) -> String {
        let authority = parse_target_scheme(target).1;
        match authority.find(':') {
            Some(i) => authority[..i].to_string(),
            None => authority.to_string(),
        }
    }

    /// Returns Some((target, new_host_header)) if the routing engine
    /// matches `host_header`, accounting for:
    ///   * domain filter pre-check (host must end with the configured
    ///     domain suffix, if any),
    ///   * exact-domain match → ("@LANDING", "@LANDING") so the request
    ///     handler serves the landing page,
    ///   * normal rule match → (target, host_header).
    ///
    /// Returns None if the host is rejected (filter mismatch or no
    /// matching rule).
    fn route(&self, host_header: &str) -> Option<(String, String)> {
        // Drop port if present.
        let host_without_port = match host_header.find(':') {
            Some(i) => &host_header[..i],
            None => host_header,
        };

        // Exact-domain match → serve landing page. Only relevant when a
        // domain filter is configured.
        if let Some(ref domain) = self.domain_filter {
            if !domain.is_empty() && host_without_port.eq_ignore_ascii_case(domain) {
                return Some(("@LANDING".to_string(), "@LANDING".to_string()));
            }
        }

        // Lock-free read of the live routes (may have been swapped by
        // the file watcher mid-flight). `.load()` returns an Arc; we
        // hold a reference for the duration of the match.
        let routes_guard = self.compiled_routes.load();
        let hit = routes::match_host_with_domain(
            routes_guard.as_ref(),
            host_header,
            self.domain_filter.as_deref(),
        )?;

        let RouteHit { target, host_header: rewrite, .. } = hit;
        let new_host = rewrite.unwrap_or_else(|| Self::host_from_target(&target));
        Some((target, new_host))
    }

    pub async fn handle_request(&self, req: Request<Incoming>) -> Result<Response<BoxBody>, BoxError> {
        // Extract host from headers and process according to rules
        let host_header = req
            .headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string();

        // Route the host via the rule engine.
        let parsed_host = self.route(&host_header);

        // If domain filter rejects the host, return 502 Bad Gateway
        let (target_host, new_host) = match parsed_host {
            Some(hosts) => hosts,
            None => {
                let method = req.method();
                let uri = req.uri();
                info!(
                    "{} {} => REJECTED{} 502",
                    method,
                    host_header,
                    uri
                );
                self.metrics.host_rejected_total.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.metrics.record_status(502);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from("Bad Gateway: Host not allowed")).map_err(|e| match e {}).boxed())?);
            }
        };

        // Serve landing page for root domain access
        if target_host == "@LANDING" {
            info!("GET {} => LANDING 200", host_header);
            self.metrics.record_status(200);
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/html; charset=utf-8")
                .body(Full::new(Bytes::from(Self::landing_page_html())).map_err(|e| match e {}).boxed())?);
        }

        let method = req.method().clone();
        let original_uri = req.uri().clone();

        // Handle HTTP CONNECT tunneling (used by browsers for WebSocket/HTTPS through proxy)
        if method == Method::CONNECT {
            // For CONNECT, the URI contains the target authority (host:port)
            // Parse the target from the URI
            let connect_target = if let Some(authority) = req.uri().authority() {
                authority.to_string()
            } else {
                // Fallback to parsed host
                target_host.clone()
            };

            // Apply domain filtering to CONNECT target
            let connect_host = connect_target.split(':').next().unwrap_or(&connect_target);
            if let Some(ref domain) = self.domain_filter {
                if !domain.is_empty() && !connect_host.ends_with(domain) {
                    info!(
                        "CONNECT {} => REJECTED{} 502",
                        host_header,
                        original_uri
                    );
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .body(Full::new(Bytes::from("Bad Gateway: Host not allowed")).map_err(|e| match e {}).boxed())?);
                }
            }

            // Parse the connect target for routing
            let tunnel_target = if let Some(ref domain) = self.domain_filter {
                if !domain.is_empty() && connect_host.ends_with(domain) {
                    // Strip domain and apply routing rules
                    let prefix_len = connect_host.len() - domain.len();
                    let stripped = if prefix_len > 0 && connect_host.chars().nth(prefix_len - 1) == Some('.') {
                        &connect_host[..prefix_len - 1]
                    } else if prefix_len == 0 {
                        "localhost"
                    } else {
                        connect_host
                    };

                    // Apply number rule: if stripped is numeric, route to localhost:port
                    if self.number_regex.is_match(stripped) {
                        // Get the port from the connect target
                        let _port = connect_target.split(':').nth(1).unwrap_or("80");
                        format!("localhost:{}", stripped)
                    } else {
                        connect_target.clone()
                    }
                } else {
                    connect_target.clone()
                }
            } else {
                connect_target.clone()
            };

            info!(
                "CONNECT {}@{}{} tunneling",
                host_header,
                tunnel_target,
                original_uri
            );

            // Connect to upstream with timeout
            let connect_result = timeout(
                Duration::from_secs(3),
                TcpStream::connect(&tunnel_target)
            ).await;

            match connect_result {
                Ok(Ok(upstream)) => {
                    // Spawn a task to handle the tunnel
                    tokio::spawn(async move {
                        // The upgrade happens after we return the response
                        // We need to use hyper's upgrade mechanism
                        match hyper::upgrade::on(req).await {
                            Ok(upgraded) => {
                                let mut upgraded = TokioIo::new(upgraded);
                                let mut upstream = upstream;

                                // Bidirectional copy
                                if let Err(e) = copy_bidirectional(&mut upgraded, &mut upstream).await {
                                    error!("Tunnel error: {}", e);
                                }
                            }
                            Err(e) => {
                                error!("Upgrade error: {}", e);
                            }
                        }
                    });

                    // Return 200 Connection Established
                    return Ok(Response::builder()
                        .status(StatusCode::OK)
                        .body(Full::new(Bytes::new()).map_err(|e| match e {}).boxed())?);
                }
                Ok(Err(e)) => {
                    error!(
                        "CONNECT {}@{}{} 502 ({})",
                        host_header,
                        tunnel_target,
                        original_uri,
                        e
                    );
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .header("Content-Type", "text/plain")
                        .body(Full::new(Bytes::from(format!("502 Bad Gateway: failed to connect to {}: {}", tunnel_target, e))).map_err(|e| match e {}).boxed())?);
                }
                Err(_) => {
                    error!(
                        "CONNECT {}@{}{} 502 (connection timeout)",
                        host_header,
                        tunnel_target,
                        original_uri
                    );
                    return Ok(Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .header("Content-Type", "text/plain")
                        .body(Full::new(Bytes::from(format!("502 Bad Gateway: connection to {} timed out", tunnel_target))).map_err(|e| match e {}).boxed())?);
                }
            }
        }

        // Handle WebSocket upgrade requests
        if hyper_tungstenite::is_upgrade_request(&req) {
            self.metrics.websocket_upgrades_total.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return self
                .handle_websocket_upgrade(req, &target_host, &new_host)
                .await;
        }

        // Build target URL for HTTP requests. parse_target_scheme handles
        // an optional `http://` / `https://` prefix on the matched target
        // so routes like `target: "https://api.github.com:443"` reach
        // upstream over TLS via the HttpsConnector wired in FBIProxy::new.
        let uri = req.uri();
        let (scheme, authority) = parse_target_scheme(&target_host);
        let target_url = format!(
            "{}://{}{}",
            scheme,
            authority,
            uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
        );
        let target_uri: Uri = target_url.parse()?;

        // Convert incoming body to a format the client can use
        let (mut parts, incoming_body) = req.into_parts();
        let body = incoming_body.map_err(|e| e).boxed();

        // Update request URI and headers
        parts.uri = target_uri;
        parts.headers.insert(HOST, HeaderValue::from_str(&new_host)?);
        // Preserve content-encoding header to maintain compression

        // Rebuild the request with the converted body
        let new_req = Request::from_parts(parts, body);

        // Forward the request with timeout
        let request_result = timeout(
            Duration::from_secs(3),
            self.client.request(new_req)
        ).await;

        match request_result {
            Ok(Ok(response)) => {
                // Preserve content-encoding header in response to maintain compression
                let status = response.status();
                info!(
                    "{} {}@{}{} {}",
                    method,
                    host_header,
                    target_host,
                    original_uri,
                    status.as_u16()
                );
                self.metrics.record_status(status.as_u16());
                // Convert the response body back to BoxBody
                let (parts, body) = response.into_parts();
                let boxed_body = body.map_err(|e| e).boxed();
                Ok(Response::from_parts(parts, boxed_body))
            }
            Ok(Err(e)) => {
                error!(
                    "{} {}@{}{} 502 ({})",
                    method,
                    host_header,
                    target_host,
                    original_uri,
                    e
                );
                self.metrics.upstream_connect_failures_total.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.metrics.record_status(502);
                Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .header("Content-Type", "text/plain")
                    .body(Full::new(Bytes::from(format!("502 Bad Gateway: failed to connect to {}: {}", target_host, e))).map_err(|e| match e {}).boxed())?)
            }
            Err(_) => {
                error!(
                    "{} {}@{}{} 502 (request timeout)",
                    method,
                    host_header,
                    target_host,
                    original_uri
                );
                self.metrics.upstream_timeouts_total.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.metrics.record_status(502);
                Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .header("Content-Type", "text/plain")
                    .body(Full::new(Bytes::from(format!("502 Bad Gateway: request to {} timed out", target_host))).map_err(|e| match e {}).boxed())?)
            }
        }
    }

    async fn handle_websocket_upgrade(
        &self,
        req: Request<Incoming>,
        target_host: &str,
        _new_host: &str, // Currently not used for WebSocket connections, but kept for consistency
    ) -> Result<Response<BoxBody>, BoxError> {
        let uri = req.uri().clone();
        let (scheme, authority) = parse_target_scheme(target_host);
        let ws_scheme = if scheme == "https" { "wss" } else { "ws" };
        let ws_url = format!(
            "{}://{}{}",
            ws_scheme,
            authority,
            uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
        );

        // Step 1: Connect to upstream WebSocket FIRST before upgrading client
        // This ensures we can return proper errors if upstream is unavailable
        let (upstream_ws, _) = match connect_async(&ws_url).await {
            Ok(ws) => ws,
            Err(e) => {
                error!("WS :ws:{} => :ws:{}{} 502 (upstream connection failed: {})", target_host, target_host, uri, e);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .header("Content-Type", "text/plain")
                    .body(Full::new(Bytes::from(format!("502 Bad Gateway: WebSocket upstream {} unavailable: {}", target_host, e))).map_err(|e| match e {}).boxed())?);
            }
        };

        // Step 2: Now upgrade the HTTP connection to WebSocket
        // Only do this after confirming upstream is available
        let (response, websocket) = hyper_tungstenite::upgrade(req, None)?;

        // Step 3: Spawn task to handle WebSocket forwarding
        tokio::spawn(async move {
            if let Err(e) = handle_websocket_forwarding(websocket, upstream_ws).await {
                error!("WebSocket forwarding error: {}", e);
            }
        });

        info!("WS :ws:{} => :ws:{}{} 101", target_host, target_host, uri);
        let (parts, body) = response.into_parts();
        let boxed_body = body.map_err(|_: std::convert::Infallible| unreachable!()).boxed();
        Ok(Response::from_parts(parts, boxed_body))
    }
}

/// Parse a route target into (scheme, authority). Supports an optional
/// `http://` or `https://` prefix; defaults to `http` so existing
/// `host:port`-style targets keep working unchanged. Used by both the
/// HTTP forwarder (chooses URL scheme) and the WebSocket upgrade path
/// (chooses `ws` vs `wss`).
fn parse_target_scheme(target: &str) -> (&'static str, &str) {
    if let Some(rest) = target.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = target.strip_prefix("http://") {
        ("http", rest)
    } else {
        ("http", target)
    }
}

async fn handle_websocket_forwarding(
    websocket: HyperWebsocket,
    upstream_ws: WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) -> Result<(), BoxError> {
    // Get the client WebSocket stream
    let client_ws = websocket.await?;

    let (mut client_sink, mut client_stream) = client_ws.split();
    let (mut upstream_sink, mut upstream_stream) = upstream_ws.split();

    // Forward messages from client to upstream
    let client_to_upstream = async {
        while let Some(msg) = client_stream.next().await {
            match msg {
                Ok(msg) => {
                    if let Err(_) = upstream_sink.send(msg).await {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    // Forward messages from upstream to client
    let upstream_to_client = async {
        while let Some(msg) = upstream_stream.next().await {
            match msg {
                Ok(msg) => {
                    if let Err(_) = client_sink.send(msg).await {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    // Run both forwarding tasks concurrently
    tokio::select! {
        _ = client_to_upstream => {},
        _ = upstream_to_client => {},
    }
    Ok(())
}

async fn handle_connection(
    req: Request<Incoming>,
    proxy: Arc<FBIProxy>,
) -> Result<Response<BoxBody>, Infallible> {
    match proxy.handle_request(req).await {
        Ok(response) => Ok(response),
        Err(e) => {
            error!("Request handling error: {}", e);
            Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header("Content-Type", "text/plain")
                .body(Full::new(Bytes::from(format!("500 Internal Server Error: {}", e))).map_err(|e| match e {}).boxed())
                .unwrap())
        }
    }
}

/// Load routes from `routes.yaml` source text and compile them. Panics
/// with a descriptive message on parse or compile failure — this is
/// only invoked at startup, so failing fast is the right policy.
fn load_routes(yaml_src: &str, source_label: &str) -> Vec<CompiledRoute> {
    let parsed = match routes::parse_yaml(yaml_src) {
        Ok(p) => p,
        Err(e) => panic!("failed to parse {}: {}", source_label, e),
    };
    match routes::compile(parsed.routes) {
        Ok(c) => c,
        Err(e) => panic!("failed to compile {}: {}", source_label, e),
    }
}

/// Run a tiny HTTP server on 127.0.0.1:{port} that responds to
/// `GET /metrics` with the current counters in Prometheus text format.
/// All other paths return 404. The endpoint binds loopback-only so
/// metrics aren't exposed via the user-facing proxy port.
async fn serve_metrics(
    metrics: Arc<Metrics>,
    port: u16,
) -> Result<(), BoxError> {
    let addr: SocketAddr = format!("127.0.0.1:{}", port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    info!("[metrics] listening on http://{}/metrics", addr);
    println!("[metrics] listening on http://{}/metrics", addr);

    loop {
        let (stream, _) = listener.accept().await?;
        let metrics = Arc::clone(&metrics);
        let io = TokioIo::new(stream);
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let metrics = Arc::clone(&metrics);
                async move {
                    let resp = if req.uri().path() == "/metrics" {
                        let body = metrics.render_prometheus();
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("Content-Type", "text/plain; version=0.0.4")
                            .body(Full::new(Bytes::from(body)).map_err(|e| match e {}).boxed())
                            .unwrap()
                    } else {
                        Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Full::new(Bytes::from("not found")).map_err(|e| match e {}).boxed())
                            .unwrap()
                    };
                    Ok::<_, Infallible>(resp)
                }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                error!("[metrics] connection error: {}", e);
            }
        });
    }
}

/// Parse + compile a routes file without panicking. Returns Err with a
/// human-readable message on any failure. Used by the hot-reload path
/// where we want to log + keep current rules rather than crash.
fn try_reload_routes(path: &str) -> Result<Vec<CompiledRoute>, String> {
    let yaml = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {}", path, e))?;
    let parsed = routes::parse_yaml(&yaml)
        .map_err(|e| format!("parse {}: {}", path, e))?;
    routes::compile(parsed.routes)
        .map_err(|e| format!("compile {}: {}", path, e))
}

/// Watch a routes file and atomically swap in new rules on change.
/// Debounces flurries of FS events (some editors save by truncate+
/// rewrite which can fire multiple notifications in ~ms). On parse or
/// compile failure, log a warning and leave the existing rules in
/// place — the running proxy continues to work with whatever last
/// loaded successfully.
fn spawn_routes_watcher(
    path: String,
    handle: Arc<ArcSwap<Vec<CompiledRoute>>>,
) {
    use notify::{RecursiveMode, Watcher};
    use std::sync::mpsc;

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            // Best-effort forward; if the receiver is gone the watcher
            // thread is shutting down anyway.
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                error!("[routes hot-reload] failed to create watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(
            std::path::Path::new(&path),
            RecursiveMode::NonRecursive,
        ) {
            error!("[routes hot-reload] failed to watch {}: {}", path, e);
            return;
        }

        info!("[routes hot-reload] watching {}", path);

        // Debounce window — wait this long for the burst to subside
        // before reloading.
        const DEBOUNCE: Duration = Duration::from_millis(150);

        loop {
            // Block for the next event.
            match rx.recv() {
                Ok(Ok(_event)) => {}
                Ok(Err(e)) => {
                    warn!("[routes hot-reload] watcher error: {}", e);
                    continue;
                }
                Err(_) => break, // sender dropped — proxy shutting down
            }
            // Drain any additional events that arrive during the debounce
            // window, so a single save that fires 3 events triggers
            // exactly one reload.
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }

            match try_reload_routes(&path) {
                Ok(new_routes) => {
                    let n = new_routes.len();
                    handle.store(Arc::new(new_routes));
                    info!("[routes hot-reload] reloaded {} rule(s) from {}", n, path);
                }
                Err(reason) => {
                    warn!(
                        "[routes hot-reload] reload failed, keeping previous rules: {}",
                        reason
                    );
                }
            }
        }
    });
}

pub struct TlsOptions {
    /// Apex domain used for SAN entries on the self-signed cert.
    /// Empty string falls back to `localhost` + `127.0.0.1`.
    pub domain: String,
    /// Directory the generated cert+key are persisted to. The same
    /// fingerprint is reused across boots so browsers can remember
    /// "trust this exception" once.
    pub cert_dir: std::path::PathBuf,
}

pub async fn start_proxy_server(
    host: Option<&str>,
    port: u16,
    domain_filter: Option<String>,
    compiled_routes: Vec<CompiledRoute>,
    watch_path: Option<String>,
    tls: Option<TlsOptions>,
) -> Result<(), BoxError> {
    let host = host.unwrap_or("127.0.0.1");
    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    let proxy = Arc::new(FBIProxy::new(domain_filter.clone(), compiled_routes));

    // Hot-reload: when the user pointed us at a routes file with
    // --routes, spawn a background watcher that re-parses + swaps in
    // new rules on file change. Failures leave the current rules in
    // place — never crash the running proxy because of a typo in YAML.
    if let Some(path) = watch_path {
        spawn_routes_watcher(path, proxy.routes_handle());
    }

    // Metrics: when FBI_PROXY_METRICS_PORT is set, expose a 127.0.0.1-bound
    // Prometheus-text endpoint at /metrics on that port. Off by default —
    // never exposed on the proxy's user-traffic port.
    if let Ok(metrics_port_str) = std::env::var("FBI_PROXY_METRICS_PORT") {
        if let Ok(metrics_port) = metrics_port_str.parse::<u16>() {
            let metrics = proxy.metrics_handle();
            tokio::spawn(async move {
                if let Err(e) = serve_metrics(metrics, metrics_port).await {
                    error!("[metrics] server exited: {}", e);
                }
            });
        } else {
            warn!(
                "[metrics] FBI_PROXY_METRICS_PORT='{}' is not a valid port number; metrics disabled",
                metrics_port_str
            );
        }
    }

    let acceptor = match &tls {
        Some(opts) => {
            let acc = fbi_proxy::tls::build_acceptor(&opts.domain, &opts.cert_dir)?;
            // Auto-install the self-signed leaf as a system trust anchor when
            // running with the privileges to do so. Idempotent — no-op if
            // already trusted. If unprivileged (and untrusted), this errors and
            // we surface a clear message rather than booting silently into
            // "browser warnings forever" mode.
            let cert_path = fbi_proxy::tls::cert_pem_path(&opts.domain, &opts.cert_dir);
            match fbi_proxy::tls::install_to_system_trust(&cert_path) {
                Ok(true) => println!(
                    "TLS: cert installed to system trust store ({})",
                    cert_path.display()
                ),
                Ok(false) => {}
                Err(e) => {
                    eprintln!(
                        "[tls] could not auto-install cert to system trust: {e}\n      \
                         start with sudo to install, or accept the browser warning."
                    );
                }
            }
            Some(acc)
        }
        None => None,
    };

    let listener = TcpListener::bind(addr).await?;

    let scheme = if acceptor.is_some() { "https" } else { "http" };
    info!("FBI Proxy server running on {}://{}", scheme, addr);
    println!("FBI Proxy listening on: {}://{}", scheme, addr);
    if let Some(opts) = &tls {
        println!(
            "TLS: self-signed cert at {}/{}.pem (browser warning expected — Phase 1)",
            opts.cert_dir.display(),
            if opts.domain.is_empty() { "localhost" } else { &opts.domain }
        );
    }
    if let Some(ref domain) = domain_filter {
        if !domain.is_empty() {
            println!("Domain filter: Only accepting requests for *.{}", domain);
        }
    }
    println!();
    println!("== HOW IT WORKS ==");
    println!("Routes requests based on Host header (configurable via routes.yaml):");
    println!("  3000         -> localhost:3000  (port as host)");
    println!("  api--8080    -> api:8080        (host--port syntax)");
    println!("  3000.fbi.com -> localhost:3000  (subdomain as port)");
    println!("  app.server   -> server:80       (subdomain hoisting)");
    println!();
    println!("== CADDY SETUP ==");
    println!("# Caddyfile - expose *.fbi.example.com to local ports");
    println!("*.fbi.example.com {{");
    println!("  tls {{ dns cloudflare {{env.CF_API_TOKEN}} }}");
    println!("  reverse_proxy localhost:2432");
    println!("}}");
    println!();
    println!("Then: fbi-proxy -d fbi.example.com");
    println!("  https://3000.fbi.example.com -> localhost:3000");
    println!("  https://8080.fbi.example.com -> localhost:8080");
    println!();
    println!("⚠️ FBI-Proxy WARNING: ENSURE YOU KNOW WHAT YOU'RE DOING and be sure to set up an auth gateway before exposing to the internet");
    println!("   This proxy is production ready but requires proper security measures.");

    info!("Features: HTTP proxying + WebSocket forwarding + Port encoding + Domain filtering");

    loop {
        let (stream, _) = listener.accept().await?;
        let proxy = proxy.clone();
        let acceptor = acceptor.clone();

        tokio::task::spawn(async move {
            let service = service_fn(move |req| handle_connection(req, proxy.clone()));

            let mut builder = http1::Builder::new();
            builder
                .preserve_header_case(true)
                .title_case_headers(true);

            match acceptor {
                Some(a) => match a.accept(stream).await {
                    Ok(tls_stream) => {
                        let io = TokioIo::new(tls_stream);
                        if let Err(err) = builder.serve_connection(io, service).with_upgrades().await {
                            error!("Error serving TLS connection: {:?}", err);
                        }
                    }
                    Err(err) => {
                        error!("TLS handshake failed: {:?}", err);
                    }
                },
                None => {
                    let io = TokioIo::new(stream);
                    if let Err(err) = builder.serve_connection(io, service).with_upgrades().await {
                        error!("Error serving connection: {:?}", err);
                    }
                }
            }
        });
    }
}

fn main() {
    env_logger::init();

    let matches = Command::new(env!("CARGO_CRATE_NAME"))
        .version("0.1.1")
        .about("A fast and flexible proxy server with smart host header parsing and WebSocket support")
        .long_about(
"FBI Proxy - A any-host-port reverse-proxy server with intelligent host header parsing

FEATURES:
  • HTTP and WebSocket proxying with bidirectional forwarding
  • Smart host header parsing with multiple routing rules (configurable via routes.yaml)
  • Port encoding support for easy local development
  • Subdomain hoisting for multi-service architectures

HOST PARSING RULES (default routes.yaml):
  1. Number host → local port:     '3000' → localhost:3000
  2. Host--port syntax:            'api--3000' → api:3000
  3. Subdomain hoisting:           'api.service' → service:80 (host: api)
  4. Default routing:              'localhost' → localhost:80

ENVIRONMENT VARIABLES:
  FBI_PROXY_PORT                   Port to listen on (default: 2432)
  FBI_PROXY_HOST                   Host/IP address to bind to (default: 127.0.0.1)
  FBI_PROXY_DOMAIN                 Domain filter (only accept *.domain requests)
  FBI_PROXY_ROUTES                 Path to a custom routes.yaml (default: bundled)
  RUST_LOG                         Log level (error, warn, info, debug, trace)

EXAMPLES:
  fbi-proxy                        # Start on 127.0.0.1:2432, accept all
  fbi-proxy -p 8080               # Custom port
  fbi-proxy -h 0.0.0.0 -p 3000   # Bind to all interfaces
  fbi-proxy -d example.com        # Only accept *.example.com requests
  fbi-proxy -r ./my-routes.yaml   # Use a custom routing config
  FBI_PROXY_PORT=8080 fbi-proxy   # Use environment variable

TRY RUN:
  # HOST_A:
  npx serve --port 3000
  fbi-proxy -h 0.0.0.0 -p 2432

  # HOST_B:
  curl http://HOST_A:2432 -H 'Host: localhost--3000'
"
        )
        .arg(
            Arg::new("port")
                .short('p')
                .long("port")
                .value_name("PORT")
                .help("Port to listen on (env: FBI_PROXY_PORT, default: 2432)")
                .env("FBI_PROXY_PORT")
                .default_value("2432")
        )
        .arg(
            Arg::new("host")
                .short('h')
                .long("host")
                .value_name("HOST")
                .help("Host/IP address to bind to (env: FBI_PROXY_HOST, default: 127.0.0.1)")
                .env("FBI_PROXY_HOST")
                .default_value("127.0.0.1")
        )
        .arg(
            Arg::new("domain")
                .short('d')
                .long("domain")
                .value_name("DOMAIN")
                .help("Domain filter - only accept requests for *.domain (env: FBI_PROXY_DOMAIN)")
                .env("FBI_PROXY_DOMAIN")
                .default_value("")
        )
        .arg(
            Arg::new("routes")
                .short('r')
                .long("routes")
                .value_name("PATH")
                .help("Path to a custom routes.yaml (env: FBI_PROXY_ROUTES, default: bundled)")
                .env("FBI_PROXY_ROUTES")
                .default_value("")
        )
        .arg(
            Arg::new("tls")
                .long("tls")
                .help("Terminate TLS using a self-signed cert (browser warning expected — Phase 1, no system trust install). Use --port 443 with sudo for the standard HTTPS port. (env: FBI_PROXY_TLS)")
                .env("FBI_PROXY_TLS")
                .num_args(0)
                .action(clap::ArgAction::SetTrue)
        )
        .arg(
            Arg::new("cert-dir")
                .long("cert-dir")
                .value_name("DIR")
                .help("Directory for the self-signed cert+key (env: FBI_PROXY_CERT_DIR, default: ~/.config/fbi-proxy/certs)")
                .env("FBI_PROXY_CERT_DIR")
                .default_value("")
        )
        .get_matches();

    let tls_enabled = matches.get_flag("tls");

    // Default port jumps to 443 when --tls is set unless the user explicitly
    // overrode --port / FBI_PROXY_PORT. Binding :443 needs sudo on most
    // systems; the helpful failure path is documented in the bind error.
    let port_source = matches.value_source("port");
    let port_explicit = matches!(
        port_source,
        Some(clap::parser::ValueSource::CommandLine)
            | Some(clap::parser::ValueSource::EnvVariable)
    );
    let port = if tls_enabled && !port_explicit {
        443
    } else {
        matches
            .get_one::<String>("port")
            .unwrap()
            .parse::<u16>()
            .unwrap_or_else(|_| {
                error!("Invalid port value, using default 2432");
                2432
            })
    };

    let host = matches.get_one::<String>("host").unwrap();
    let domain = matches.get_one::<String>("domain").unwrap();
    let routes_path = matches.get_one::<String>("routes").unwrap();

    let domain_filter = if domain.is_empty() {
        None
    } else {
        Some(domain.clone())
    };

    // Load routes: either from --routes <path> or the bundled default.
    // The bundled YAML is baked into the binary and can't change at
    // runtime, so hot reload only applies to the --routes path.
    let (compiled_routes, watch_path) = if routes_path.is_empty() {
        (load_routes(BUNDLED_ROUTES_YAML, "bundled routes.yaml"), None)
    } else {
        let src = match std::fs::read_to_string(routes_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("error: failed to read --routes file '{}': {}", routes_path, e);
                std::process::exit(2);
            }
        };
        (
            load_routes(&src, &format!("routes file '{}'", routes_path)),
            Some(routes_path.clone()),
        )
    };

    let cert_dir_raw = matches.get_one::<String>("cert-dir").unwrap();
    let tls_opts = if tls_enabled {
        let cert_dir = if cert_dir_raw.is_empty() {
            fbi_proxy::tls::default_cert_dir()
        } else {
            std::path::PathBuf::from(cert_dir_raw)
        };
        Some(TlsOptions {
            domain: domain.clone(),
            cert_dir,
        })
    } else {
        None
    };

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        info!(
            "Starting FBI-Proxy on {}:{} with domain filter: {:?}, tls: {}",
            host, port, domain_filter, tls_enabled
        );
        if let Err(e) = start_proxy_server(
            Some(host),
            port,
            domain_filter,
            compiled_routes,
            watch_path,
            tls_opts,
        )
        .await
        {
            error!("Failed to start proxy server: {}", e);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::parse_target_scheme;

    #[test]
    fn parse_target_scheme_defaults_to_http_with_no_prefix() {
        assert_eq!(parse_target_scheme("localhost:3000"), ("http", "localhost:3000"));
        assert_eq!(parse_target_scheme("api"), ("http", "api"));
        assert_eq!(parse_target_scheme("127.0.0.1:80"), ("http", "127.0.0.1:80"));
    }

    #[test]
    fn parse_target_scheme_strips_http_prefix() {
        assert_eq!(parse_target_scheme("http://localhost:3000"), ("http", "localhost:3000"));
    }

    #[test]
    fn parse_target_scheme_strips_https_prefix() {
        assert_eq!(
            parse_target_scheme("https://api.github.com:443"),
            ("https", "api.github.com:443"),
        );
        assert_eq!(
            parse_target_scheme("https://example.dev"),
            ("https", "example.dev"),
        );
    }
}
