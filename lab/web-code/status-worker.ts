/// <reference lib="webworker" />
/**
 * SharedWorker: ONE WebSocket for the whole origin, multiplexing git-status
 * subscriptions across every tab.
 *
 * Each tab connects via a MessagePort and sends `{type:'sub'|'unsub', rel}`.
 * The worker dedupes by `rel` (ref-counted), forwards sub/unsub over the
 * single socket, fans status back to the interested ports, and caches the
 * latest status per repo so a new or returning tab gets current state at once.
 *
 * Why a SharedWorker + one WS instead of per-tab SSE:
 *   - HTTP/1.1 caps ~6 connections per origin; long-lived per-tab streams
 *     exhaust the pool and stall everything once you pass ~6 tabs.
 *   - One shared socket scales to many tabs and keeps running while tabs are
 *     backgrounded, so the tab title stays live (Slack-style) without focus.
 *   - The socket auto-reconnects and re-subscribes; because the server always
 *     sends a fresh snapshot on (re)subscribe, state is self-healing.
 */

type GitStatus = {
  branch: string;
  head: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  hasUpstream: boolean;
};
type InMsg = { type: "sub" | "unsub" | "close"; rel?: string };
type OutMsg = { rel: string; activity?: boolean; status?: GitStatus };

const ports = new Set<MessagePort>();
const portRels = new Map<MessagePort, Set<string>>(); // each port's subscriptions
const refCount = new Map<string, number>(); // rel -> number of interested ports
const lastStatus = new Map<string, GitStatus>(); // rel -> latest known status

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string {
  // The worker's origin is the page origin (e.g. https://fbi.com); match ws/wss.
  return location.origin.replace(/^http/, "ws") + "/api/watch-ws";
}

function send(m: InMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connect(): void {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    // Re-subscribe everything currently wanted; the server replies with a
    // fresh snapshot per rel, so a reconnect transparently re-syncs all tabs.
    for (const rel of refCount.keys()) send({ type: "sub", rel });
  };
  ws.onmessage = (e) => {
    let msg: OutMsg;
    try {
      msg = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch {
      return;
    }
    if (!msg || !msg.rel) return;
    if (msg.status) lastStatus.set(msg.rel, msg.status); // cache only real status
    for (const p of ports)
      if (portRels.get(p)?.has(msg.rel)) p.postMessage(msg);
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1500);
}

function addSub(port: MessagePort, rel: string): void {
  let rels = portRels.get(port);
  if (!rels) {
    rels = new Set();
    portRels.set(port, rels);
  }
  if (rels.has(rel)) return;
  rels.add(rel);
  const n = (refCount.get(rel) ?? 0) + 1;
  refCount.set(rel, n);
  if (n === 1) send({ type: "sub", rel }); // first tab interested → tell server
  const cached = lastStatus.get(rel);
  if (cached) port.postMessage({ rel, status: cached }); // hand over current state now
}

function removeSub(port: MessagePort, rel: string): void {
  const rels = portRels.get(port);
  if (!rels || !rels.has(rel)) return;
  rels.delete(rel);
  const n = (refCount.get(rel) ?? 1) - 1;
  if (n <= 0) {
    refCount.delete(rel);
    lastStatus.delete(rel);
    send({ type: "unsub", rel }); // last tab gone → stop the server-side watch
  } else {
    refCount.set(rel, n);
  }
}

function dropPort(port: MessagePort): void {
  const rels = portRels.get(port);
  if (rels) for (const rel of [...rels]) removeSub(port, rel);
  portRels.delete(port);
  ports.delete(port);
}

// SharedWorker connection from a new tab.
(self as unknown as SharedWorkerGlobalScope).onconnect = (e: MessageEvent) => {
  const port = e.ports[0];
  ports.add(port);
  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as InMsg;
    if (m.type === "sub" && m.rel) addSub(port, m.rel);
    else if (m.type === "unsub" && m.rel) removeSub(port, m.rel);
    else if (m.type === "close") dropPort(port);
  };
  port.start();
};

connect();
