# Why `/healthz`? — The "z-pages" story

`fbi-auth` exposes a liveness endpoint at [`/healthz`](../src/routes/health.ts), not `/health`. That trailing `z` is not a typo — it's a 25-year-old Google convention that Kubernetes inherited, and it's followed for a real reason.

## The convention

Google's internal servers have used **z-pages** (endpoints ending in `z`) for HTTP-based introspection since the early 2000s. Examples:

| Path        | Purpose                            |
| ----------- | ---------------------------------- |
| `/healthz`  | Liveness probe                     |
| `/statusz`  | Server-state dump                  |
| `/varz`     | Exported metrics / variable values |
| `/rpcz`     | RPC-call statistics                |
| `/threadz`  | Thread dump                        |
| `/configz`  | Current configuration              |
| `/profilez` | CPU / heap profiles                |

The pattern was canonical enough internally that "z-page" became a noun engineers used in design docs.

## Why the trailing `z`?

**Namespace separation.** A bare `/health` route could collide with a real application route — imagine an e-commerce site with `/health` listing health-and-wellness products, or a fitness app with `/health/<user>`. The `z` suffix is uncommon enough in English vocabulary that a path like `/healthz` is almost certainly an infrastructure endpoint, not application content.

It's effectively a poor man's URL namespace: "anything ending in `z` is for operators, not users."

## How it reached Kubernetes

Kubernetes was created by Google engineers from the Borg team in 2014. Borg's process-management lessons came with it, including the z-page convention. The default liveness/readiness probe path in early Kubernetes manifests was [`/healthz`](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/), and from there the convention spread to:

- Most CNCF projects (etcd, Prometheus, Envoy, …)
- Almost every modern reverse-proxy and auth gateway (Caddy, Traefik, Authelia, tinyauth, oauth2-proxy)
- Cloud-platform health checks (GKE, EKS, AKS load-balancer defaults)

Kubernetes itself later refined the split:

- `/livez` — am I alive? (restart if false)
- `/readyz` — am I ready to serve traffic? (remove from load-balancer if false)
- `/healthz` — legacy alias of the above (deprecated in newer k8s components but kept for back-compat)

## What `fbi-auth` does

[`routes/health.ts`](../src/routes/health.ts) returns the plain text `ok` with status `200`. No JSON, no body parsing — Kubernetes' probe handler, Docker's `HEALTHCHECK`, and most monitoring tools accept any 2xx as healthy. Keeping the response trivial means the endpoint can't itself be a source of latency.

The reasoning for staying with `/healthz` rather than splitting into `/livez` and `/readyz`:

- fbi-auth has no separate "ready" state — once the Hono app is built (after Google OIDC discovery completes during `buildApp()`), it's ready.
- The single endpoint matches what 99 % of generic Kubernetes manifests, Docker Compose `healthcheck:` blocks, and uptime monitors default to.
- Phase 5 may add `/readyz` if a backing store (SQLite, Redis) is introduced and a meaningful readiness check becomes possible.

## Exposure

Three reachability surfaces, by design:

| URL                               | Exposed to         | Why                                                                        |
| --------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| `http://127.0.0.1:<port>/healthz` | Local host         | Supervisor, Docker `HEALTHCHECK`, sidecar liveness                         |
| `https://sso.<domain>/healthz`    | Public             | Caddy reverse-proxies the SSO host as a whole; allows external uptime ping |
| `https://<sub>.<domain>/healthz`  | Authenticated only | `forward_auth` runs first; unauthenticated visitors get `401`, not `200`   |

The public exposure on `sso.<domain>` is intentional but trivially leaks "an fbi-auth instance is running here" — which `/login`'s redirect behavior already reveals, so there's no marginal information loss.

## Further reading

- [Kubernetes liveness, readiness and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Google SRE Book — Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [k8s API server has a `/livez` and `/readyz` design](https://kubernetes.io/docs/reference/using-api/health-checks/) — the modern split

## TL;DR

`/healthz` is a 25-year-old Google infrastructure convention that Kubernetes propagated to the whole industry. The `z` deliberately makes the path unlikely to collide with application routes. We use it because every supervisor on Earth defaults to looking for it.
