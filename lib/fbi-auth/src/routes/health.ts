import { Hono } from "hono";

export function healthRoute(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));
  return app;
}
