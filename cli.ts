import minimist from "minimist";
import type { WebSocketHandler } from "bun";
import DIE from "phpdie";
import WebSocket from "ws";
import hotMemo from "hot-memo";
import { exec } from "child_process";

// ifim
// setup(){
//     // windows service
// // 1. install chocolatey
// // 2. choco upgrade caddys
// // caddy_path = "C:\\ProgramData\\chocolatey\\lib\\caddy\\tools\\caddy.exe"
// // await snorun('sc.exe create caddy start= auto binPath= "YOURPATH\caddy.exe run"')
// }

// assume caddy is installed

const argv = minimist(process.argv.slice(2), {})
console.log(argv)

interface WSData {
    url: string;
    headers: Headers;
    protocols: string[];
    proxy: WebSocket;
    buffer: TransformStream;
}

const server = Bun.serve({
    port: +(process.env.PROXY_PORT || 9975),
    fetch: async (req, server) => {
        const xfh =
            req.headers.get("x-forwarded-host") || req.headers.get("host") || "";

        // Handle WebSocket upgrade requests
        if (req.headers.get("upgrade") === "websocket") {
            const protocols =
                req.headers
                    .get("sec-websocket-protocol")
                    ?.split(",")
                    .map((p) => p.trim()) || [];
            try {
                const buffer = new TransformStream();
                const wsurl = req.url.replace(/^http/, "ws");
                const ws = await new Promise<WebSocket>((resolve, reject) => {
                    const proxy = new WebSocket(wsurl, protocols);
                    proxy.addEventListener("open", () => {
                        resolve(proxy);
                    });
                    const writer = buffer.writable.getWriter();
                    proxy.addEventListener("message", async (data) => {
                        await writer.write(data.data);
                    });
                    proxy.once("error", (error) => {
                        reject(error);
                    });
                    proxy.once("close", () => {
                        writer.close();
                    });
                });
                const success = server.upgrade<WSData>(req, {
                    data: {
                        url: wsurl,
                        headers: req.headers,
                        protocols: protocols,
                        proxy: ws,
                        buffer: buffer,
                    },
                });
                if (success) {
                    return;
                } else {
                    return new Response("WebSocket upgrade failed", { status: 400 });
                }
            } catch (error) {
                return new Response("WebSocket connection failed", { status: 502 });
            }
        }

        // console.log(req)
        // console.log(req.method + " " + req.url);
        // allow access all ports from localhost
        // console.log("Accessing: " + req.url);
        // console.log("Request headers: ", req.headers);
        try {
            const resp = await fetch(req.url, {
                method: req.method,
                headers: {
                    ...req.headers,
                    // set host to x-forwarded-host
                    host: xfh,
                    // "x-forwarded-host": req
                    // "x-forwarded-proto": req
                    // "x-forwarded-port": req
                },
                body: req.body,
                redirect: "manual", // Handle redirects manually

                // duplex: "half", // Use half-duplex for streaming responses
            });
            // if the request is to localhost, allow it
            // console.log("Response status: " + resp.status);

            // const body = await resp.text();
            // console.log("Response body: " + body.slice(0, 100) + "...");
            // console.log("Response headers: ", resp.headers);
            const headers = resp.headers;
            headers.delete("content-encoding"); // Remove content-encoding header
            return new Response(resp.body, {
                status: resp.status,
                headers: headers,
            });
        } catch (error) {
            return new Response("Gateway Error", { status: 502 });
        }
    },
    websocket: {
        open(ws) {
            ws.data.proxy!.addEventListener("close", (event) => {
                ws.close(event.code, event.reason);
            });
            ws.data.buffer.readable.pipeTo(
                new WritableStream({
                    write(chunk) {
                        ws.send(chunk); // Send the chunk to the WebSocket client
                    },
                })
            );
        },
        message(ws, message) {
            ws.data.proxy!.send(message);
        },
        async close(ws, code, reason) {
            // Close the upstream WebSocket connection and clean up buffers
            try {
                await ws.data.buffer.writable.close();
                await ws.data.buffer.readable.cancel();
            } catch (error) {
                // Ignore errors during cleanup
            }
            ws.data.proxy!.close();
        },
    } satisfies WebSocketHandler<WSData>,
});

console.log('serving proxy on ' + server.url)


const caddyfileContent = `
{
	admin off
}

fbi.com {
    tls internal
    respond "Welcome to FBI-PROXY"
}

# unwrap fbi.com
*.fbi.com {
	tls internal
	@proxyhostport header_regexp service Host (.+?\\.)fbi\\.com
	reverse_proxy @proxyhostport :80 {
		header_up Host {re.service.1}fbi.com
	}
}

http://* {
	# 3000.fbi.com
	@localportforward {
		header_regexp localportforward Host ^([0-9]+)$
		header_regexp xfh X-Forwarded-Host ^(.+)$
	}
	# localhost--3000.fbi.com
	@hostportforward {
		header_regexp hostportforward Host ^([a-z0-9-]+)--([0-9]+)$
		header_regexp xfh X-Forwarded-Host ^(.+)$
	}
	# adminer.fbi.com, must start with a-z
	@openservices {
		header_regexp openservices Host ^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$
		header_regexp xfh X-Forwarded-Host ^(.+)$
	}
	handle @openservices {
		reverse_proxy :{$PROXY_PORT} {
			header_up X-Forwarded-Host {re.xfh.1}
			header_up Host {re.openservices.1}
		}
	}
	handle @hostportforward {
		reverse_proxy :{$PROXY_PORT} {
			# pass through the X-Forwarded-Host header as original
			header_up X-Forwarded-Host {re.xfh.1}
			header_up Host {re.hostportforward.1}:{re.hostportforward.2}
		}
	}
	handle @localportforward {
		reverse_proxy :{$PROXY_PORT} {
			# pass through the X-Forwarded-Host header as original
			header_up X-Forwarded-Host {re.xfh.1}
			header_up Host localhost:{re.localportforward.1}
		}
	}
}

`
const tmpCaddyfile = "./cache/Caddyfile";
await Bun.write(tmpCaddyfile, caddyfileContent)
console.log('Starting Caddy')

const p = await hotMemo(() => {
    const p = exec(`caddy run --watch --config ${tmpCaddyfile}`, {
        env: {
            ...process.env
        }
    });
    p.stdout?.pipe(process.stdout, { end: false });
    p.stderr?.pipe(process.stderr, { end: false });
    p.on("exit", (code) => process.exit(code));
    return p;
})
console.log(p.exitCode)
console.log('all done')
