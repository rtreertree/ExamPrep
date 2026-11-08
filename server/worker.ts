import { createApp } from "./app";
import { PrismaClient } from "../generated/worker/client";
import { PrismaNeon } from "@prisma/adapter-neon";
export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/api" && !pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request);
    const app = createApp(
      { ...env, RUNTIME: "worker" },
      (url) =>
        new PrismaClient({
          adapter: new PrismaNeon({ connectionString: url }),
        }),
    );
    return app.fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
