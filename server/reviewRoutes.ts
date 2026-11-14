import type { Hono } from "hono";
import { z } from "zod";
import { MAX_DAILY_REVIEWS } from "../shared/spacedReview";
import type { Context } from "./app";
import { readInsights } from "./insights";
import { read, schema } from "./request";
import {
  changeReviewLimit,
  readReviewQueue,
  startSpacedReview,
} from "./spacedReview";

export function registerReviewRoutes(app: Hono<Context>) {
  app.get("/api/insights", async (c) =>
    c.json(
      await readInsights(
        c.get("db"),
        c.get("userId"),
        c.req.query("setId") ?? null,
      ),
    ),
  );
  app.get("/api/sets/:id/review", async (c) =>
    c.json(
      await readReviewQueue(c.get("db"), c.get("userId"), c.req.param("id")),
    ),
  );
  app.patch("/api/sets/:id/review", async (c) => {
    const { limit } = schema(
      z.strictObject({ limit: z.number().int().min(1).max(MAX_DAILY_REVIEWS) }),
      await read(c.req.raw),
    );
    return c.json(
      await changeReviewLimit(
        c.get("db"),
        c.get("userId"),
        c.req.param("id"),
        limit,
      ),
    );
  });
  app.post("/api/sets/:id/review", async (c) => {
    schema(z.strictObject({}), await read(c.req.raw));
    const { id, started } = await startSpacedReview(
      c.get("db"),
      c.get("userId"),
      c.req.param("id"),
    );
    return c.json({ id }, started ? 201 : 200);
  });
}
