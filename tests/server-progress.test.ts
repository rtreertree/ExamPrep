import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import type { Database } from "../server/db";
import { progressContent } from "../server/snapshots";
import { encodeStorage } from "../server/storage";
import type { StudyContent } from "../shared/content";
vi.mock("../server/auth", () => ({
  createAuth: () => ({
    api: { getSession: async () => ({ user: { id: "owner" } }) },
  }),
}));
const config = {
  DATABASE_URL: "postgres://secret-password@private-host/private",
  BETTER_AUTH_SECRET: "secret",
  PASSWORD_PEPPER: "a".repeat(32),
  BETTER_AUTH_URL: "https://study.example",
  RUNTIME: "worker" as const,
};
const doc: StudyContent = {
  schemaVersion: 1,
  kind: "exam",
  title: "Private title",
  questions: [
    {
      id: "one",
      type: "written",
      prompt: "Private question",
      answer: "Private reference",
    },
    { id: "two", type: "written", prompt: "Other", answer: "Other reference" },
  ],
};
function fixture(legacy = false) {
  const record = {
    id: "attempt",
    userId: "owner",
    revision: 1,
    status: "in_progress",
    position: 0,
    responses: {},
    snapshot: doc,
    snapshotVersion: legacy ? 0 : 1,
    progressContent: legacy ? null : progressContent(doc),
    result: null,
    studySetId: "set",
    sourceAttemptId: null,
    startedAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  };
  const readSnapshot = vi.fn(async () => record);
  const queries: string[] = [];
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (
      strings: TemplateStringsArray,
      id: string,
      userId: string,
    ) => {
      queries.push(strings.join("?"));
      if (id !== record.id || userId !== record.userId) return [];
      const { snapshot, ...rest } = record;
      return [structuredClone(rest)];
    },
    attempt: {
      findFirstOrThrow: readSnapshot,
      findFirst: async () => record,
      updateMany: async ({
        where,
        data,
      }: {
        where: { revision: number; status: string };
        data: Record<string, unknown>;
      }) => {
        if (
          where.revision !== record.revision ||
          where.status !== record.status
        )
          return { count: 0 };
        Object.assign(record, data, { revision: record.revision + 1 });
        return { count: 1 };
      },
    },
  };
  const db = {
    ...tx,
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx),
    $disconnect: async () => {},
  } as unknown as Database;
  return { app: createApp(config, () => db), record, queries, readSnapshot };
}
async function request(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  method = "PATCH",
) {
  return app.request(`https://study.example/api${path}`, {
    method,
    headers: {
      Origin: "https://study.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
describe("progress API trust boundary", () => {
  it("rejects a compact submission when a newer answer and submission were saved elsewhere", async () => {
    const { app, record } = fixture();
    record.status = "reviewing";
    record.revision = 3;
    const stale = await request(
      app,
      "/attempts/attempt/submit?compact=1",
      { revision: 1 },
      "POST",
    );
    expect(stale.status).toBe(409);
    const repeated = await request(
      app,
      "/attempts/attempt/submit?compact=1",
      { revision: 2 },
      "POST",
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      revision: 3,
      status: "reviewing",
    });
  });
  it("merges deltas and returns compact acknowledgements, protecting ownership and revisions", async () => {
    const { app, record, readSnapshot, queries } = fixture();
    let result = await request(app, "/attempts/attempt/progress", {
      revision: 1,
      position: 0,
      changes: { one: { text: "My latest answer" } },
    });
    expect(result.status).toBe(200);
    const metadata = await result.json();
    expect(metadata).toMatchObject({ revision: 2, status: "in_progress" });
    expect(metadata).not.toHaveProperty("snapshot");
    expect(metadata).not.toHaveProperty("responses");
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(queries[0]).not.toMatch(/[, ]snapshot[, ]/);
    expect(
      (
        await request(app, "/attempts/attempt/progress", {
          revision: 1,
          position: 0,
          changes: { one: { text: "Stale" } },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app, "/attempts/not-owned/progress", {
          revision: 2,
          position: 0,
          changes: {},
        })
      ).status,
    ).toBe(404);
    expect(record.responses).toEqual({ one: { text: "My latest answer" } });
    result = await request(
      app,
      "/attempts/attempt/submit?compact=1",
      { revision: 2 },
      "POST",
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      status: "reviewing",
      revision: 3,
    });
    expect(
      (
        await request(app, "/attempts/attempt/progress", {
          revision: 3,
          position: 0,
          changes: { one: { text: "Changed after submit" } },
        })
      ).status,
    ).toBe(422);
    result = await request(app, "/attempts/attempt/progress", {
      revision: 3,
      position: 0,
      changes: {
        one: { text: "My latest answer", selfAssessment: "incorrect" },
      },
    });
    expect(await result.json()).toMatchObject({
      status: "completed",
      revision: 4,
    });
  });
  it("validates and upgrades legacy snapshots once, keeping legacy full-map clients working", async () => {
    const { app, readSnapshot, record } = fixture(true);
    expect(
      (
        await request(app, "/attempts/attempt/progress", {
          revision: 1,
          position: 0,
          changes: { one: { text: "First" } },
        })
      ).status,
    ).toBe(200);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    expect(record.snapshotVersion).toBe(1);
    expect(
      (
        await request(app, "/attempts/attempt/progress", {
          revision: 2,
          position: 1,
          changes: { two: { text: "Second" } },
        })
      ).status,
    ).toBe(200);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
    const response = await request(app, "/attempts/attempt/progress", {
      revision: 3,
      position: 0,
      responses: { one: { text: "Legacy" } },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("snapshot");
  });
  it("provides a matching safe reference on unexpected database errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createApp(config, () => {
        throw Object.assign(new Error(config.DATABASE_URL), {
          code: "P1001",
          query: "private answers",
        });
      });
      const response = await request(
        app,
        "/attempts/private-id/progress?secret=private",
        { revision: 1, position: 0, changes: {} },
      );
      expect(response.status).toBe(500);
      const body = (await response.json()) as { reference: string };
      expect(body.reference).toBe(response.headers.get("X-Request-ID"));
      const event = JSON.parse(log.mock.calls[0][0]);
      expect(event).toMatchObject({
        requestId: body.reference,
        code: "P1001",
        category: "database",
        runtime: "worker",
      });
      expect(JSON.stringify(event)).not.toContain("private");
      expect(JSON.stringify(body)).not.toContain(config.DATABASE_URL);
    } finally {
      log.mockRestore();
    }
  });
});

describe("retry API subsets", () => {
  it("creates unreviewed-card sessions from the owned frozen snapshot and keeps the default retry separate", async () => {
    const snapshot: StudyContent = {
      schemaVersion: 1,
      kind: "flashcards",
      title: "Original deck",
      cards: [
        { id: "known", front: "Known", back: "A" },
        { id: "again", front: "Review again", back: "B" },
        { id: "revealed", front: "Revealed but unrated", back: "C" },
        { id: "unseen", front: "Unseen", back: "D" },
      ],
    };
    const source = {
      id: "source",
      userId: "owner",
      status: "completed",
      studySetId: null,
      snapshot: encodeStorage(snapshot),
      responses: encodeStorage({
        known: { revealed: true, rating: "known" },
        again: { revealed: true, rating: "review_again" },
        revealed: { revealed: true },
      }),
    };
    const original = structuredClone(source);
    const create = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: "retry",
        responses: {},
        position: 0,
        status: "in_progress",
        result: null,
      }),
    );
    const tx = {
      attempt: {
        findFirst: async ({
          where,
        }: {
          where: { id: string; userId: string };
        }) =>
          where.id === source.id && where.userId === source.userId
            ? source
            : null,
        create,
      },
    };
    const db = {
      $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(tx),
      $disconnect: async () => {},
    } as unknown as Database;
    const app = createApp(config, () => db);
    let result = await request(
      app,
      "/attempts/source/retry",
      { mode: "unreviewed" },
      "POST",
    );
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({
      snapshot: { ...snapshot, cards: snapshot.cards.slice(2) },
      sourceAttemptId: "source",
      studySetId: null,
      userId: "owner",
      status: "in_progress",
      responses: {},
      result: null,
    });
    result = await request(app, "/attempts/source/retry", {}, "POST");
    expect(result.status).toBe(201);
    const retry = (await result.json()) as { snapshot: StudyContent };
    expect(
      retry.snapshot.kind === "flashcards" && retry.snapshot.cards,
    ).toEqual([snapshot.cards[1]]);
    expect(source).toEqual(original);
    expect(
      (
        await request(
          app,
          "/attempts/not-owned/retry",
          { mode: "unreviewed" },
          "POST",
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(app, "/attempts/source/retry", { mode: "other" }, "POST"))
        .status,
    ).toBe(422);
    source.status = "in_progress";
    expect(
      (
        await request(
          app,
          "/attempts/source/retry",
          { mode: "unreviewed" },
          "POST",
        )
      ).status,
    ).toBe(409);
    source.status = "completed";
    source.snapshot = { ...snapshot, cards: snapshot.cards.slice(0, 2) };
    expect(
      (
        await request(
          app,
          "/attempts/source/retry",
          { mode: "unreviewed" },
          "POST",
        )
      ).status,
    ).toBe(422);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
