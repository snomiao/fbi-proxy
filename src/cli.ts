#!/usr/bin/env bun

import minimist from "minimist";
import type { WebSocketHandler } from "bun";
import WebSocket from "ws";
import hotMemo from "hot-memo";
import { exec } from "child_process";
import path from "path";
import { exists } from "fs/promises";

// guide to install caddy
if (!await Bun.$`caddy --version`.text().catch(() => '')) {
    console.error("Caddy is not installed. Please install Caddy first");
    console.error(`For windows, try running:\n    choco install caddy\n`);
    console.error(`For linux, try running:\n    sudo apt install caddy\n`);
    process.exit(1);
}

// assume caddy is installed, launch proxy server now
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
    port: 24306,
    fetch: async (req, server) => {
        const xfh =
            req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
        const host = req.headers.get("host")!.replace(/--(\d+).*$/, ":$1"); // Extract the port from the host header
        const url = Object.assign(new URL(req.url), { host }).href

        // Handle WebSocket upgrade requests
        if (req.headers.get("upgrade") === "websocket") {
            const protocols =
                req.headers
                    .get("sec-websocket-protocol")
                    ?.split(",")
                    .map((p) => p.trim()) || [];
            try {
                const buffer = new TransformStream();
                const wsurl = url.replace(/^http/, "ws");
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
                    return new Response(null, {
                        status: 101,
                        headers: {
                            "Upgrade": "websocket",
                            "Connection": "Upgrade",
                        }
                    });
                } else {
                    return new Response("WebSocket upgrade failed", { status: 400 });
                }
            } catch (error) {
                return new Response("WebSocket connection failed", { status: 502 });
            }
        }
        console.log(req.method + " " + url);
        // allow access all ports from localhost
        // console.log("Accessing: " + req.url) ;
        // console.log("Request headers: ", req.headers);
        try {
            const resp = await fetch(url, {
                method: req.method,
                headers: {
                    ...req.headers,
                    // set host to x-forwarded-host
                    host: 'localhost',
                    // host: xfh,
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
            console.error("Error:", error);
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


const Caddyfile = path.join(__dirname, "../Caddyfile");
if (!await exists(Caddyfile).catch(() => false)) {
    console.error("Caddyfile not found at " + Caddyfile);
    console.error("Please create a Caddyfile in the root directory of the project.");
    process.exit(1);
}
console.log('Starting Caddy')

const p = await hotMemo(() => {
    const p = exec(`caddy run --watch --config ${Caddyfile}`, {
        env: {
            ...process.env,
            PROX: String(server.port),
            TLS: argv.tls || "internal", // Use internal TLS by default, or set via command line argument
        },
        cwd: path.dirname(Caddyfile),
    });
    p.stdout?.pipe(process.stdout, { end: false });
    p.stderr?.pipe(process.stderr, { end: false });
    p.on("exit", (code) => process.exit(code));
    return p;
})
// console.log(p.exitCode)
console.log('all done')
