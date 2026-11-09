import "dotenv/config";
import { Hono } from "hono";
import { serve, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { createApp } from "./app";
import { connectDatabase } from "./db";
neonConfig.webSocketConstructor = ws;
const app = new Hono<{ Bindings: HttpBindings }>();
app.use("/api/*", async (c, next) => {
  // Replace attacker-supplied IP headers with the actual socket address.
  const incoming = c.env.incoming;
  c.req.raw.headers.set(
    "x-examprep-client-ip",
    incoming?.socket.remoteAddress ?? "127.0.0.1",
  );
  await next();
});
app.route(
  "/",
  createApp(
    {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "",
      PASSWORD_PEPPER: process.env.PASSWORD_PEPPER ?? "",
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      RESET_EMAIL_FROM: process.env.RESET_EMAIL_FROM,
      RUNTIME: "node",
    },
    connectDatabase,
  ),
);
app.use("*", serveStatic({ root: "./dist/client" }));
app.get("*", serveStatic({ path: "./dist/client/index.html" }));
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 8787),
  hostname: "0.0.0.0",
});
console.info(`Exam Prep listening on port ${process.env.PORT ?? 8787}`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
