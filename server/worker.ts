import { createApp } from "./app";
import { PrismaClient } from "../generated/worker/client";
import { PrismaNeon } from "@prisma/adapter-neon";
type WorkerEnv = Cloudflare.Env & {
  RESEND_API_KEY?: string;
  RESET_EMAIL_FROM?: string;
};
export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/api" && !pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request);
    const app = createApp(
      { ...env, RUNTIME: "worker", waitUntil: (task) => ctx.waitUntil(task) },
      (url) =>
        new PrismaClient({
          adapter: new PrismaNeon({ connectionString: url }),
        }),
    );
    return app.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
