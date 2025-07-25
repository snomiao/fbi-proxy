use futures_util::{SinkExt, StreamExt};
use hyper::header::{HeaderValue, HOST};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Client, Request, Response, Server, StatusCode, Uri};
use hyper_tungstenite::{HyperWebsocket, WebSocketStream};
use log::{error, info};
use regex::Regex;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio_tungstenite::connect_async;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

pub struct FBIProxy {
    client: Client<hyper::client::HttpConnector>,
    port_regex: Regex,
}

impl FBIProxy {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            port_regex: Regex::new(r"--(\d+).*$").unwrap(),
        }
    }

    fn extract_target_host(&self, host_header: &str) -> String {
        self.port_regex.replace(host_header, ":$1").to_string()
    }

    pub async fn handle_request(&self, mut req: Request<Body>) -> Result<Response<Body>, BoxError> {
        // Extract host from headers and process port encoding
        let host_header = req
            .headers()
            .get(HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost");

        let target_host = self.extract_target_host(host_header);
        info!("Proxying {} {} -> {}", req.method(), req.uri(), target_host);

        // Handle WebSocket upgrade requests
        if hyper_tungstenite::is_upgrade_request(&req) {
            return self.handle_websocket_upgrade(req, &target_host).await;
        }

        // Build target URL for HTTP requests
        let uri = req.uri();
        let target_url = format!(
            "http://{}{}",
            target_host,
            uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
        );
        let target_uri: Uri = target_url.parse()?;

        // Update request URI and headers
        *req.uri_mut() = target_uri;
        req.headers_mut()
            .insert(HOST, HeaderValue::from_str("localhost")?);
        req.headers_mut().remove("content-encoding");

        // Forward the request
        match self.client.request(req).await {
            Ok(mut response) => {
                // Remove content-encoding header from response
                response.headers_mut().remove("content-encoding");
                info!("HTTP {} -> {}", target_url, response.status());
                Ok(response)
            }
            Err(e) => {
                error!("Proxy error for {}: {}", target_url, e);
                Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Body::from("Gateway Error"))?)
            }
        }
    }

    async fn handle_websocket_upgrade(
        &self,
        req: Request<Body>,
        target_host: &str,
    ) -> Result<Response<Body>, BoxError> {
        let uri = req.uri();
        let ws_url = format!(
            "ws://{}{}",
            target_host,
            uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
        );

        info!("WebSocket upgrade to: {}", ws_url);

        // Upgrade the HTTP connection to WebSocket
        let (response, websocket) = hyper_tungstenite::upgrade(req, None)?;

        // Connect to upstream WebSocket
        info!("Connecting to upstream WebSocket: {}", ws_url);
        let (upstream_ws, _) = match connect_async(&ws_url).await {
            Ok(ws) => ws,
            Err(e) => {
                error!("Failed to connect to upstream WebSocket {}: {}", ws_url, e);
                return Ok(Response::builder()
                    .status(StatusCode::BAD_GATEWAY)
                    .body(Body::from("WebSocket connection failed"))?);
            }
        };

        // Spawn task to handle WebSocket forwarding
        info!("Starting WebSocket forwarding for: {}", ws_url);
        let ws_url_clone = ws_url.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_websocket_forwarding(websocket, upstream_ws).await {
                error!("WebSocket forwarding error for {}: {}", ws_url_clone, e);
            }
        });

        info!("WebSocket upgrade successful for: {}", ws_url);
        Ok(response)
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

    info!("WebSocket connection established, starting bidirectional forwarding");

    // Forward messages from client to upstream
    let client_to_upstream = async {
        while let Some(msg) = client_stream.next().await {
            match msg {
                Ok(msg) => {
                    info!("Client -> Upstream: {:?}", msg);
                    if let Err(e) = upstream_sink.send(msg).await {
                        error!("Failed to forward message to upstream: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    error!("Error receiving from client: {}", e);
                    break;
                }
            }
        }
        info!("Client-to-upstream forwarding ended");
    };

    // Forward messages from upstream to client
    let upstream_to_client = async {
        while let Some(msg) = upstream_stream.next().await {
            match msg {
                Ok(msg) => {
                    info!("Upstream -> Client: {:?}", msg);
                    if let Err(e) = client_sink.send(msg).await {
                        error!("Failed to forward message to client: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    error!("Error receiving from upstream: {}", e);
                    break;
                }
            }
        }
        info!("Upstream-to-client forwarding ended");
    };

    // Run both forwarding tasks concurrently
    tokio::select! {
        _ = client_to_upstream => {
            info!("Client disconnected");
        }
        _ = upstream_to_client => {
            info!("Upstream disconnected");
        }
    }

    info!("WebSocket forwarding session ended");
    Ok(())
}

async fn handle_connection(
    req: Request<Body>,
    proxy: Arc<FBIProxy>,
) -> Result<Response<Body>, Infallible> {
    match proxy.handle_request(req).await {
        Ok(response) => Ok(response),
        Err(e) => {
            error!("Request handling error: {}", e);
            Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("Internal Server Error"))
                .unwrap())
        }
    }
}

pub async fn start_proxy_server(port: u16) -> Result<(), BoxError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let proxy = Arc::new(FBIProxy::new());

    let make_svc = make_service_fn(move |_conn| {
        let proxy = proxy.clone();
        async move { Ok::<_, Infallible>(service_fn(move |req| handle_connection(req, proxy.clone()))) }
    });

    let server = Server::bind(&addr).serve(make_svc);

    info!("FBI Proxy server running on http://{}", addr);
    info!("Features: HTTP proxying + WebSocket forwarding + Port encoding");

    if let Err(e) = server.await {
        error!("Server error: {}", e);
    }

    Ok(())
}

fn main() {
    env_logger::init();

    // Read port from environment variable, default to 24306
    let port = std::env::var("PROXY_PORT")
        .unwrap_or_else(|_| "24306".to_string())
        .parse::<u16>()
        .unwrap_or_else(|_| {
            error!("Invalid PROXY_PORT value, using default 24306");
            24306
        });

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        info!(
            "Starting FBI Proxy with Hyper + proper WebSocket forwarding on port {}",
            port
        );
        if let Err(e) = start_proxy_server(port).await {
            error!("Failed to start proxy server: {}", e);
        }
    });
}
