import { createApp } from "./app";
import { PrismaClient } from "../generated/worker/client";
import { PrismaNeon } from "@prisma/adapter-neon";
type WorkerEnv = Cloudflare.Env & {
  RESEND_API_KEY?: string;
  RESET_EMAIL_FROM?: string;
  TEST_DATABASE_MODE?: string;
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
      {
        ...env,
        RUNTIME: "worker",
        TEST_DATABASE_MODE: env.TEST_DATABASE_MODE === "1",
        RELEASE_TAG: env.CF_VERSION_METADATA?.tag,
        waitUntil: (task) => ctx.waitUntil(task),
      },
      (url) =>
        new PrismaClient({
          adapter: new PrismaNeon({ connectionString: url }),
        }),
    );
    return app.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
