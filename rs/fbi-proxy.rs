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
/// Outcome of routing a request through the rule engine.
enum RouteDecision {
    /// Forward to `target` (upstream authority) with this outgoing `Host`.
    Hit { target: String, host: String },
    /// Serve the built-in landing page (apex domain, no matching rule).
    Landing,
    /// Reject with 502 (host not allowed / no matching rule).
    Reject,
}

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
    fn route(&self, host_header: &str, req_path: &str) -> RouteDecision {
        // Drop port if present.
        let host_without_port = match host_header.find(':') {
            Some(i) => &host_header[..i],
            None => host_header,
        };

        // CONNECT and some clients carry an empty path — treat it as "/"
        // so host-level rules (path "/" or path-less) still match. Path
        // routing only applies to L7 requests we terminate ourselves.
        let req_path = if req_path.is_empty() { "/" } else { req_path };

        // Is this the exact apex host (e.g. `fbi.com` itself, not a
        // subdomain)? The apex is reserved for the landing page unless a
        // rule *explicitly* claims it with a `path` — otherwise a bundled
        // placeholder rule like `{host}.{domain}` would swallow
        // `https://fbi.com/` and break `fbi-proxy setup`'s verification.
        let is_apex = match &self.domain_filter {
            Some(d) => !d.is_empty() && host_without_port.eq_ignore_ascii_case(d),
            None => false,
        };

        // Lock-free read of the live routes (may have been swapped by the
        // watcher/admin API mid-flight). `.load()` returns an Arc held for
        // the duration of the match. At the apex, only explicit-path rules
        // are eligible; elsewhere, normal longest-prefix matching applies.
        let routes_guard = self.compiled_routes.load();
        if let Some(hit) = routes::match_request_opts(
            routes_guard.as_ref(),
            host_header,
            req_path,
            self.domain_filter.as_deref(),
            is_apex,
        ) {
            let RouteHit { target, host_header: rewrite, .. } = hit;
            let new_host = rewrite.unwrap_or_else(|| Self::host_from_target(&target));
            return RouteDecision::Hit { target, host: new_host };
        }

        // No rule matched. Apex with a domain filter → built-in landing
        // page; anything else → reject.
        if is_apex {
            return RouteDecision::Landing;
        }
        RouteDecision::Reject
    }

    pub async fn handle_request(&self, req: Request<Incoming>) -> Result<Response<BoxBody>, BoxError> {
        // Extract host from headers and process according to rules
        let host_header = req
            .headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string();

        // Route the host + path via the rule engine.
        let req_path = req.uri().path().to_string();
        let (target_host, new_host) = match self.route(&host_header, &req_path) {
            RouteDecision::Hit { target, host } => (target, host),
            RouteDecision::Landing => {
                info!("GET {} => LANDING 200", host_header);
                self.metrics.record_status(200);
                return Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/html; charset=utf-8")
                    .body(Full::new(Bytes::from(Self::landing_page_html())).map_err(|e| match e {}).boxed())?);
            }
            RouteDecision::Reject => {
                let method = req.method();
                let uri = req.uri();
                info!("{} {} => REJECTED{} 502", method, host_header, uri);
                self.metrics.host_rejected_total.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                self.metrics.record_status(502);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from("Bad Gateway: Host not allowed")).map_err(|e| match e {}).boxed())?);
            }
        };

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

        // Build the upstream handshake request from the URL (this generates
        // the mandatory Host / Sec-WebSocket-Key / -Version / Upgrade
        // headers), then forward only the WebSocket subprotocol/extension
        // negotiation headers from the client.
        //
        // Deliberately do NOT forward `Origin`: VS Code `serve-web` accepts
        // the 101 handshake but then drops the management socket immediately
        // (101 → silent close, observed as a dead file tree behind the
        // proxy) when it sees a cross-origin `Origin` like https://fbi.com
        // against its localhost listener. The direct 127.0.0.1 path works
        // precisely because it is same-origin. `cookie`/`authorization`
        // are likewise omitted — serve-web runs `--without-connection-token`
        // and they only invite extra rejection paths.
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut upstream_req = match ws_url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                error!("WS :ws:{} => invalid upstream request {}: {}", target_host, uri, e);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from(format!("502 Bad Gateway: invalid WebSocket target: {}", e))).map_err(|e| match e {}).boxed())?);
            }
        };
        // Forward the subprotocol, but deliberately NOT
        // `Sec-WebSocket-Extensions`. If we advertise the client's
        // `permessage-deflate` to the upstream, serve-web enables
        // compression and sets the RSV1 bit on its frames — but this is a
        // separate proxy<->upstream socket whose tungstenite client did
        // not negotiate deflate, so it rejects those frames with
        // "Reserved bits are non-zero" and tears the management channel
        // down right after the 101 (the file tree never loads). Leaving
        // extensions unset keeps upstream frames uncompressed and valid.
        if let Some(v) = req.headers().get("sec-websocket-protocol") {
            upstream_req.headers_mut().insert("sec-websocket-protocol", v.clone());
        }
        // Present a same-origin Origin to the upstream so serve-web's
        // origin check (which would otherwise see https://fbi.com against
        // its localhost listener) is satisfied through the proxy.
        let upstream_origin = format!("{}://{}", scheme, authority);
        if let Ok(v) = HeaderValue::from_str(&upstream_origin) {
            upstream_req.headers_mut().insert("origin", v);
        }

        // Step 1: Connect to upstream WebSocket FIRST before upgrading client
        // This ensures we can return proper errors if upstream is unavailable
        let (upstream_ws, _) = match connect_async(upstream_req).await {
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
                    if upstream_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    // Forward messages from upstream to client. A protocol error here is
    // worth surfacing — it's how the permessage-deflate RSV1 mismatch
    // ("Reserved bits are non-zero") manifested before we stopped
    // advertising the client's WS extensions upstream.
    let upstream_to_client = async {
        while let Some(msg) = upstream_stream.next().await {
            match msg {
                Ok(msg) => {
                    if client_sink.send(msg).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    warn!("[ws] upstream recv error: {}", e);
                    break;
                }
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

/// Shared state for the loopback admin/control server.
struct AdminState {
    metrics: Arc<Metrics>,
    routes_handle: Arc<ArcSwap<Vec<CompiledRoute>>>,
    /// conf.d directory. `Some` enables the mutating `/rules` endpoints;
    /// `None` (legacy `--routes` single-file mode) makes them 409.
    conf_dir: Option<std::path::PathBuf>,
}

fn admin_text(status: StatusCode, content_type: &str, body: String) -> Response<BoxBody> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .body(Full::new(Bytes::from(body)).map_err(|e| match e {}).boxed())
        .unwrap()
}

fn admin_json(status: StatusCode, body: String) -> Response<BoxBody> {
    admin_text(status, "application/json", body)
}

fn admin_err(status: StatusCode, msg: &str) -> Response<BoxBody> {
    admin_json(status, serde_json::json!({ "error": msg }).to_string())
}

/// A namespace must be a safe filename stem (it becomes `<ns>.yaml`).
fn is_valid_namespace(ns: &str) -> bool {
    !ns.is_empty()
        && ns.len() <= 64
        && ns.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Serialize the live compiled routes to a JSON array for `GET /rules`.
fn rules_to_json(routes: &[CompiledRoute]) -> String {
    let arr: Vec<serde_json::Value> = routes
        .iter()
        .map(|r| {
            serde_json::json!({
                "namespace": r.namespace,
                "name": r.name,
                "match": r.match_pattern,
                "path": r.path_prefix,
                "target": r.target_template,
                "headers": r.header_templates,
            })
        })
        .collect();
    serde_json::to_string(&arr).unwrap_or_else(|_| "[]".to_string())
}

async fn handle_admin(req: Request<Incoming>, state: Arc<AdminState>) -> Response<BoxBody> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    match (&method, path.as_str()) {
        (&Method::GET, "/metrics") => {
            admin_text(StatusCode::OK, "text/plain; version=0.0.4", state.metrics.render_prometheus())
        }
        (&Method::GET, "/rules") => {
            let routes = state.routes_handle.load();
            admin_json(StatusCode::OK, rules_to_json(routes.as_ref()))
        }
        (&Method::PUT, p) if p.starts_with("/rules/") => {
            let ns = p.trim_start_matches("/rules/").to_string();
            handle_put_rules(req, state, ns).await
        }
        (&Method::DELETE, p) if p.starts_with("/rules/") => {
            let ns = p.trim_start_matches("/rules/").to_string();
            handle_delete_rules(state, ns).await
        }
        _ => admin_err(StatusCode::NOT_FOUND, "not found"),
    }
}

/// Reconcile namespace `ns` to the rules in the request body: validate +
/// compile, write `<conf_dir>/<ns>.yaml`, then rebuild + atomically swap
/// the live route set. Returns the new merged rule list on success.
async fn handle_put_rules(
    req: Request<Incoming>,
    state: Arc<AdminState>,
    ns: String,
) -> Response<BoxBody> {
    let conf_dir = match &state.conf_dir {
        Some(d) => d.clone(),
        None => {
            return admin_err(
                StatusCode::CONFLICT,
                "rule mutation requires conf.d mode (started with --routes single-file mode)",
            )
        }
    };
    if !is_valid_namespace(&ns) {
        return admin_err(
            StatusCode::BAD_REQUEST,
            "invalid namespace (allowed: A-Za-z0-9_-, max 64 chars)",
        );
    }

    let body_bytes = match req.into_body().collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => return admin_err(StatusCode::BAD_REQUEST, &format!("read body: {}", e)),
    };
    let src = String::from_utf8_lossy(&body_bytes);
    let parsed = match routes::parse_yaml(&src) {
        Ok(p) => p,
        Err(e) => return admin_err(StatusCode::BAD_REQUEST, &format!("parse: {}", e)),
    };
    // Validate by compiling under this namespace *before* touching disk.
    if let Err(e) = routes::compile_in_namespace(parsed.routes.clone(), &ns) {
        return admin_err(StatusCode::BAD_REQUEST, &format!("compile: {}", e));
    }
    let yaml = match serde_yaml::to_string(&parsed) {
        Ok(y) => y,
        Err(e) => return admin_err(StatusCode::INTERNAL_SERVER_ERROR, &format!("serialize: {}", e)),
    };
    let frag_path = conf_dir.join(format!("{}.yaml", ns));
    if let Err(e) = std::fs::write(&frag_path, yaml) {
        return admin_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("write {}: {}", frag_path.display(), e),
        );
    }
    match rebuild_routes(&conf_dir, BUNDLED_ROUTES_YAML) {
        Ok(merged) => state.routes_handle.store(Arc::new(merged)),
        Err(e) => {
            return admin_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("rebuild after write: {}", e),
            )
        }
    }
    info!("[admin] applied {} rule(s) to namespace '{}'", parsed.routes.len(), ns);
    let routes = state.routes_handle.load();
    admin_json(StatusCode::OK, rules_to_json(routes.as_ref()))
}

/// Remove namespace `ns`: delete its fragment, rebuild + swap.
async fn handle_delete_rules(state: Arc<AdminState>, ns: String) -> Response<BoxBody> {
    let conf_dir = match &state.conf_dir {
        Some(d) => d.clone(),
        None => {
            return admin_err(
                StatusCode::CONFLICT,
                "rule mutation requires conf.d mode (started with --routes single-file mode)",
            )
        }
    };
    if !is_valid_namespace(&ns) {
        return admin_err(
            StatusCode::BAD_REQUEST,
            "invalid namespace (allowed: A-Za-z0-9_-, max 64 chars)",
        );
    }
    let frag_path = conf_dir.join(format!("{}.yaml", ns));
    let existed = frag_path.exists();
    if existed {
        if let Err(e) = std::fs::remove_file(&frag_path) {
            return admin_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("remove {}: {}", frag_path.display(), e),
            );
        }
    }
    match rebuild_routes(&conf_dir, BUNDLED_ROUTES_YAML) {
        Ok(merged) => state.routes_handle.store(Arc::new(merged)),
        Err(e) => {
            return admin_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("rebuild after delete: {}", e),
            )
        }
    }
    info!("[admin] removed namespace '{}' (existed: {})", ns, existed);
    admin_json(StatusCode::OK, serde_json::json!({ "ok": true, "removed": existed }).to_string())
}

/// Run the loopback admin/control server on an already-bound listener.
/// Serves `GET /metrics`, `GET /rules`, `PUT /rules/{ns}`,
/// `DELETE /rules/{ns}`. Binds loopback-only so it is never reachable
/// from the user-facing proxy port.
async fn serve_admin(state: Arc<AdminState>, listener: TcpListener) -> Result<(), BoxError> {
    loop {
        let (stream, _) = listener.accept().await?;
        let state = Arc::clone(&state);
        let io = TokioIo::new(stream);
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let state = Arc::clone(&state);
                async move { Ok::<_, Infallible>(handle_admin(req, state).await) }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                error!("[admin] connection error: {}", e);
            }
        });
    }
}

/// Publish `runtime.json` (next to conf.d) so `fbi-proxy up/down/ps` can
/// discover the running daemon's admin port. Single-instance model:
/// last writer wins.
fn write_runtime_json(conf_dir: &std::path::Path, admin_port: u16, proxy_port: u16) {
    let runtime_path = conf_dir
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("runtime.json");
    let body = serde_json::json!({
        "adminPort": admin_port,
        "proxyPort": proxy_port,
        "pid": std::process::id(),
        "confDir": conf_dir.to_string_lossy(),
    });
    match std::fs::write(&runtime_path, serde_json::to_string_pretty(&body).unwrap_or_default()) {
        Ok(_) => info!("[admin] wrote {}", runtime_path.display()),
        Err(e) => warn!("[admin] could not write {}: {}", runtime_path.display(), e),
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

/// The conf.d directory holding per-namespace route fragments.
/// `FBI_PROXY_CONF_DIR` overrides; default `~/.config/fbi-proxy/conf.d`.
fn default_conf_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("FBI_PROXY_CONF_DIR") {
        if !d.is_empty() {
            return std::path::PathBuf::from(d);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".config/fbi-proxy/conf.d")
}

/// Rebuild the merged compiled route set: bundled defaults (namespace
/// `"default"`) followed by every `<conf_dir>/*.yaml` fragment (namespace
/// = file stem), sorted by filename so ordering is deterministic.
/// Returns Err with a human-readable message on any parse/compile error
/// so callers can log + keep the previous rules instead of crashing.
fn rebuild_routes(
    conf_dir: &std::path::Path,
    bundled_yaml: &str,
) -> Result<Vec<CompiledRoute>, String> {
    let parsed = routes::parse_yaml(bundled_yaml)
        .map_err(|e| format!("parse bundled routes: {}", e))?;
    let mut merged = routes::compile_in_namespace(parsed.routes, "default")
        .map_err(|e| format!("compile bundled routes: {}", e))?;

    if conf_dir.is_dir() {
        let mut paths: Vec<std::path::PathBuf> = std::fs::read_dir(conf_dir)
            .map_err(|e| format!("read {}: {}", conf_dir.display(), e))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                matches!(
                    p.extension().and_then(|x| x.to_str()),
                    Some("yaml") | Some("yml")
                )
            })
            .collect();
        paths.sort();
        for path in paths {
            let ns = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let src = std::fs::read_to_string(&path)
                .map_err(|e| format!("read {}: {}", path.display(), e))?;
            let parsed = routes::parse_yaml(&src)
                .map_err(|e| format!("parse {}: {}", path.display(), e))?;
            let compiled = routes::compile_in_namespace(parsed.routes, &ns)
                .map_err(|e| format!("compile {}: {}", path.display(), e))?;
            merged.extend(compiled);
        }
    }
    Ok(merged)
}

/// Watch the conf.d directory and atomically swap in the merged rule set
/// on any change. Same debounce + fail-soft policy as the single-file
/// watcher: a bad fragment logs a warning and leaves current rules in
/// place. External edits and admin-API writes both converge here because
/// disk is the source of truth.
fn spawn_conf_dir_watcher(
    conf_dir: std::path::PathBuf,
    bundled_yaml: &'static str,
    handle: Arc<ArcSwap<Vec<CompiledRoute>>>,
) {
    use notify::{RecursiveMode, Watcher};
    use std::sync::mpsc;

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        }) {
            Ok(w) => w,
            Err(e) => {
                error!("[routes hot-reload] failed to create watcher: {}", e);
                return;
            }
        };

        if let Err(e) = watcher.watch(&conf_dir, RecursiveMode::NonRecursive) {
            error!(
                "[routes hot-reload] failed to watch {}: {}",
                conf_dir.display(),
                e
            );
            return;
        }
        info!("[routes hot-reload] watching {}", conf_dir.display());

        const DEBOUNCE: Duration = Duration::from_millis(150);
        loop {
            match rx.recv() {
                Ok(Ok(_event)) => {}
                Ok(Err(e)) => {
                    warn!("[routes hot-reload] watcher error: {}", e);
                    continue;
                }
                Err(_) => break,
            }
            while rx.recv_timeout(DEBOUNCE).is_ok() {}

            match rebuild_routes(&conf_dir, bundled_yaml) {
                Ok(new_routes) => {
                    let n = new_routes.len();
                    handle.store(Arc::new(new_routes));
                    info!("[routes hot-reload] reloaded {} rule(s) from {}", n, conf_dir.display());
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
    conf_dir: Option<std::path::PathBuf>,
    admin_port: Option<u16>,
    tls: Option<TlsOptions>,
) -> Result<(), BoxError> {
    let host = host.unwrap_or("127.0.0.1");
    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    let proxy = Arc::new(FBIProxy::new(domain_filter.clone(), compiled_routes));

    // Hot-reload. In conf.d mode (the default) we watch the directory and
    // re-merge bundled + all fragments on change. In legacy single-file
    // mode (--routes <file>) we watch just that file. Failures leave the
    // current rules in place — never crash on a typo in YAML.
    if let Some(dir) = conf_dir.clone() {
        spawn_conf_dir_watcher(dir, BUNDLED_ROUTES_YAML, proxy.routes_handle());
    } else if let Some(path) = watch_path {
        spawn_routes_watcher(path, proxy.routes_handle());
    }

    // Admin/control server: always on, loopback-only. Serves /metrics and
    // (in conf.d mode) the /rules API. Binds an ephemeral port unless
    // --admin-port / FBI_PROXY_ADMIN_PORT (or legacy FBI_PROXY_METRICS_PORT)
    // pins one. The bound port is published to runtime.json so the CLI can
    // find it.
    {
        let pinned = admin_port.or_else(|| {
            std::env::var("FBI_PROXY_METRICS_PORT")
                .ok()
                .and_then(|s| s.parse::<u16>().ok())
        });
        let admin_addr = format!("127.0.0.1:{}", pinned.unwrap_or(0));
        match TcpListener::bind(&admin_addr).await {
            Ok(listener) => {
                let bound = listener
                    .local_addr()
                    .map(|a| a.port())
                    .unwrap_or_else(|_| pinned.unwrap_or(0));
                info!("[admin] listening on http://127.0.0.1:{}", bound);
                println!("[admin] control API on http://127.0.0.1:{}/ (/metrics, /rules)", bound);
                if let Some(dir) = &conf_dir {
                    write_runtime_json(dir, bound, port);
                }
                let state = Arc::new(AdminState {
                    metrics: proxy.metrics_handle(),
                    routes_handle: proxy.routes_handle(),
                    conf_dir: conf_dir.clone(),
                });
                tokio::spawn(async move {
                    if let Err(e) = serve_admin(state, listener).await {
                        error!("[admin] server exited: {}", e);
                    }
                });
            }
            Err(e) => warn!("[admin] could not bind {}: {} — admin API disabled", admin_addr, e),
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
        .arg(
            Arg::new("conf-dir")
                .long("conf-dir")
                .value_name("DIR")
                .help("conf.d directory of per-namespace route fragments (env: FBI_PROXY_CONF_DIR, default: ~/.config/fbi-proxy/conf.d). Ignored when --routes is set.")
                .env("FBI_PROXY_CONF_DIR")
                .default_value("")
        )
        .arg(
            Arg::new("admin-port")
                .long("admin-port")
                .value_name("PORT")
                .help("Loopback admin/control port for /metrics and the /rules API (env: FBI_PROXY_ADMIN_PORT, default: ephemeral). FBI_PROXY_METRICS_PORT is accepted as an alias.")
                .env("FBI_PROXY_ADMIN_PORT")
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

    // Load routes. Two modes:
    //   * --routes <file>  → legacy single-file mode (file fully replaces
    //     the bundled defaults; hot-reload watches that one file).
    //   * otherwise        → conf.d mode (default): merge bundled defaults
    //     with every <conf_dir>/*.yaml fragment; the admin API + CLI
    //     manage fragments at runtime, and the dir is hot-reloaded.
    let (compiled_routes, watch_path, conf_dir) = if !routes_path.is_empty() {
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
            None,
        )
    } else {
        let cli_conf_dir = matches.get_one::<String>("conf-dir").map(String::as_str).unwrap_or("");
        let dir = if cli_conf_dir.is_empty() {
            default_conf_dir()
        } else {
            std::path::PathBuf::from(cli_conf_dir)
        };
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("warning: could not create conf dir '{}': {}", dir.display(), e);
        }
        let compiled = match rebuild_routes(&dir, BUNDLED_ROUTES_YAML) {
            Ok(c) => c,
            Err(reason) => {
                eprintln!(
                    "warning: failed to load conf.d ({}); falling back to bundled defaults",
                    reason
                );
                load_routes(BUNDLED_ROUTES_YAML, "bundled routes.yaml")
            }
        };
        (compiled, None, Some(dir))
    };

    let admin_port = matches
        .get_one::<String>("admin-port")
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u16>().ok());

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
            conf_dir,
            admin_port,
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
