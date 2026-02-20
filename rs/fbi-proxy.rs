use clap::{Arg, Command};
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, HOST};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode, Uri};
use hyper_tungstenite::{HyperWebsocket, WebSocketStream};
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioIo;
use log::{error, info};
use regex::Regex;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

pub struct FBIProxy {
    client: Client<HttpConnector, BoxBody>,
    number_regex: Regex,
    domain_filter: Option<String>,
}

/*
FBIProxy is a simple HTTP and WebSocket proxy server that supports port encoding in the Host header.

parse incoming Host headers and convert them to a target URL format:

for localhost, it uses "localhost"

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
        - if sur also runs fbi-proxy, it will proxies to http://amd:80, with host: amd
    - 3000.sur.amd => proxies to http://amd:80, with host: 3000.sur

for subdomains
*.amd => localhost:amd

*/
impl FBIProxy {
    pub fn new(domain_filter: Option<String>) -> Self {
        let connector = HttpConnector::new();
        let client = Client::builder(hyper_util::rt::TokioExecutor::new())
            .build(connector);

        Self {
            client,
            number_regex: Regex::new(r"^\d+$").unwrap(),
            domain_filter,
        }
    }

    fn parse_host(&self, host_header: &str, domain_filter: &Option<String>) -> Option<(String, String)> {
        // Remove port if present (e.g., "localhost:8080" -> "localhost")
        let host_without_port = if let Some(colon_pos) = host_header.find(':') {
            &host_header[..colon_pos]
        } else {
            host_header
        };
        
        // Apply domain filter if specified
        let host = if let Some(domain) = domain_filter {
            if !domain.is_empty() {
                // Check if host ends with the domain filter
                if host_without_port.ends_with(domain) {
                    // Strip the domain suffix (including the dot)
                    let prefix_len = host_without_port.len() - domain.len();
                    if prefix_len > 0 && host_without_port.chars().nth(prefix_len - 1) == Some('.') {
                        // Remove the domain and the dot before it
                        &host_without_port[..prefix_len - 1]
                    } else if prefix_len == 0 {
                        // The host is exactly the domain, treat as root
                        "@"
                    } else {
                        // No dot separator, invalid format
                        return None;
                    }
                } else {
                    // Host doesn't match domain filter
                    return None;
                }
            } else {
                // Empty domain filter, accept all
                host_without_port
            }
        } else {
            // No domain filter, accept all
            host_without_port
        };

        // Handle special case: @ means root domain was accessed
        if host == "@" {
            return Some(("localhost:80".to_string(), "localhost".to_string()));
        }
        
        // Rule 1: number host goes to local port (e.g., "3000" => "localhost:3000")
        if self.number_regex.is_match(host) {
            return Some((format!("localhost:{}", host), "localhost".to_string()));
        }

        // Rule 1.2: host--port goes to host:port (e.g., "localhost--3000" => "localhost:3000")
        if let Some(double_dash_pos) = host.find("--") {
            let hostname = &host[..double_dash_pos];
            let port = &host[double_dash_pos + 2..];
            return Some((format!("{}:{}", hostname, port), hostname.to_string()));
        }

        // Rule 3: subdomains are hoisted
        let parts: Vec<&str> = host.split('.').collect();
        if parts.len() > 1 {
            // The last part is the main domain, everything before is subdomain
            let main_domain = parts.last().unwrap();
            let subdomain_parts = &parts[..parts.len() - 1];
            let subdomain = subdomain_parts.join(".");

            // Target is the main domain on port 80
            let target_host = format!("{}:80", main_domain);
            // New host header is the subdomain
            return Some((target_host, subdomain.to_string()));
        }

        // Rule 2: other host goes to that host:80 (e.g., "localhost" => "localhost:80")
        Some((format!("{}:80", host), host.to_string()))
    }

    pub async fn handle_request(&self, req: Request<Incoming>) -> Result<Response<BoxBody>, BoxError> {
        // Extract host from headers and process according to rules
        let host_header = req
            .headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string();

        // Parse host with domain filtering
        let parsed_host = self.parse_host(&host_header, &self.domain_filter);
        
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
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from("Bad Gateway: Host not allowed")).map_err(|e| match e {}).boxed())?);
            }
        };
        
        let method = req.method().clone();
        let original_uri = req.uri().clone();

        // Handle WebSocket upgrade requests
        if hyper_tungstenite::is_upgrade_request(&req) {
            return self
                .handle_websocket_upgrade(req, &target_host, &new_host)
                .await;
        }

        // Build target URL for HTTP requests
        let uri = req.uri();
        let target_url = format!(
            "http://{}{}",
            target_host,
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

        // Forward the request
        match self.client.request(new_req).await {
            Ok(response) => {
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
                // Convert the response body back to BoxBody
                let (parts, body) = response.into_parts();
                let boxed_body = body.map_err(|e| e).boxed();
                Ok(Response::from_parts(parts, boxed_body))
            }
            Err(e) => {
                error!(
                    "{} {}@{}{} 502 ({})",
                    method,
                    host_header,
                    target_host,
                    original_uri,
                    e
                );
                Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Full::new(Bytes::from("FBIPROXY ERROR")).map_err(|e| match e {}).boxed())?)
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
        let ws_url = format!(
            "ws://{}{}",
            target_host,
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
                    .body(Full::new(Bytes::from("WebSocket upstream unavailable")).map_err(|e| match e {}).boxed())?);
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
                .body(Full::new(Bytes::from("Internal Server Error")).map_err(|e| match e {}).boxed())
                .unwrap())
        }
    }
}

pub async fn start_proxy_server(host: Option<&str>, port: u16, domain_filter: Option<String>) -> Result<(), BoxError> {
    let host = host.unwrap_or("127.0.0.1");
    let addr: SocketAddr = format!("{}:{}", host, port).parse()?;
    let proxy = Arc::new(FBIProxy::new(domain_filter.clone()));

    let listener = TcpListener::bind(addr).await?;

    info!("FBI Proxy server running on http://{}", addr);
    println!("FBI Proxy listening on: http://{}", addr);
    if let Some(ref domain) = domain_filter {
        if !domain.is_empty() {
            println!("Domain filter: Only accepting requests for *.{}", domain);
        }
    }
    println!("⚠️ FBI-Proxy WARNING: ENSURE YOU KNOW WHAT YOU'RE DOING and be sure to set up an auth gateway before exposing to the internet");
    println!("   This proxy is production ready but requires proper security measures.");

    info!("Features: HTTP proxying + WebSocket forwarding + Port encoding + Domain filtering");

    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let proxy = proxy.clone();

        tokio::task::spawn(async move {
            let service = service_fn(move |req| handle_connection(req, proxy.clone()));

            if let Err(err) = http1::Builder::new()
                .preserve_header_case(true)
                .title_case_headers(true)
                .serve_connection(io, service)
                .with_upgrades()
                .await
            {
                error!("Error serving connection: {:?}", err);
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
  • Smart host header parsing with multiple routing rules
  • Port encoding support for easy local development
  • Subdomain hoisting for multi-service architectures

HOST PARSING RULES:
  1. Number host → local port:     '3000' → localhost:3000
  2. Host--port syntax:            'api--3000' → api:3000
  3. Subdomain hoisting:           'api.service' → service:80 (host: api)
  4. Default routing:              'localhost' → localhost:80

ENVIRONMENT VARIABLES:
  FBI_PROXY_PORT                   Port to listen on (default: 2432)
  FBI_PROXY_HOST                   Host/IP address to bind to (default: 127.0.0.1)
  FBI_PROXY_DOMAIN                 Domain filter (only accept *.domain requests)
  RUST_LOG                         Log level (error, warn, info, debug, trace)

EXAMPLES:
  fbi-proxy                        # Start on 127.0.0.1:2432, accept all
  fbi-proxy -p 8080               # Custom port
  fbi-proxy -h 0.0.0.0 -p 3000   # Bind to all interfaces
  fbi-proxy -d example.com        # Only accept *.example.com requests
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
        .get_matches();

    let port = matches
        .get_one::<String>("port")
        .unwrap()
        .parse::<u16>()
        .unwrap_or_else(|_| {
            error!("Invalid port value, using default 2432");
            2432
        });

    let host = matches.get_one::<String>("host").unwrap();
    let domain = matches.get_one::<String>("domain").unwrap();
    
    let domain_filter = if domain.is_empty() {
        None
    } else {
        Some(domain.clone())
    };

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        info!(
            "Starting FBI-Proxy on {}:{} with domain filter: {:?}",
            host, port, domain_filter
        );
        if let Err(e) = start_proxy_server(Some(host), port, domain_filter).await {
            error!("Failed to start proxy server: {}", e);
        }
    });
}
