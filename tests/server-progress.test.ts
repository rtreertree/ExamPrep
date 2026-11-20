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
  const writes: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...args: unknown[]) => {
      if (strings.join("?").includes('UPDATE "Attempt"')) {
        const [keys, delta, position, , id, userId, revision] = args;
        if (
          record.id !== id ||
          record.userId !== userId ||
          record.revision !== revision
        )
          return 0;
        const values = { ...record.responses } as Record<string, unknown>;
        for (const key of JSON.parse(String(keys))) delete values[key];
        record.responses = Object.assign(values, JSON.parse(String(delta)));
        record.position = Number(position);
        record.revision++;
        writes.push({ delta });
      }
      return 1;
    },
    $queryRaw: async (
      query: TemplateStringsArray | { strings: string[]; values: unknown[] },
      ...parameters: unknown[]
    ) => {
      const args =
        "values" in query && "strings" in query ? query.values : parameters;
      const strings = "strings" in query ? query.strings : query;
      queries.push(strings.join("?"));
      const [id, userId] = args.slice(-2);
      if (id !== record.id || userId !== record.userId) return [];
      if (strings.join("?").includes("SELECT snapshot FROM"))
        return [await readSnapshot()];
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
        writes.push(data);
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
  return {
    app: createApp(config, () => db),
    record,
    queries,
    readSnapshot,
    writes,
  };
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
it("skips the folder list query during library pagination", async () => {
  const query = vi.fn(async () => []);
  const app = createApp(
    config,
    () =>
      ({
        $queryRaw: query,
        $disconnect: async () => {},
      }) as unknown as Database,
  );
  const original = await app.request("/api/sets?page=1");
  expect(await original.json()).toMatchObject({ folders: [], courses: [] });
  expect(query).toHaveBeenCalledTimes(2);
  query.mockClear();
  const page = await app.request("/api/sets?page=1&folders=0");
  expect(await page.json()).toEqual({ items: [], hasMore: false, page: 1 });
  expect(query).toHaveBeenCalledTimes(1);
});

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
    const { app, record, readSnapshot, queries, writes } = fixture();
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
    expect(writes[0]).not.toHaveProperty("progressContent");
    expect(writes[0]).not.toHaveProperty("snapshotVersion");
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
  it("moves the cursor without selecting or updating saved answers", async () => {
    const { app, record, writes, queries } = fixture();
    record.responses = { one: { text: "preserve me" } };
    const response = await request(app, "/attempts/attempt/progress", {
      revision: 1,
      changes: {},
      position: 1,
    });
    expect(response.status).toBe(200);
    expect(queries[0]).toContain("'{}'::jsonb AS responses");
    expect(writes[0]).not.toHaveProperty("responses");
    expect(record.responses).toEqual({ one: { text: "preserve me" } });
  });
  it("validates and upgrades legacy snapshots once, keeping legacy full-map clients working", async () => {
    const { app, readSnapshot, record, writes } = fixture(true);
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
    expect(writes[0]).toHaveProperty("progressContent");
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
    expect(writes[1]).not.toHaveProperty("progressContent");
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
