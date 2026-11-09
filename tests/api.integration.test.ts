import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { connectDatabase } from "../server/db";
import { databasePasswords, PASSWORD_PATTERN } from "../server/passwords";
neonConfig.webSocketConstructor = ws;
const enabled = process.env.RUN_DATABASE_TESTS === "1";
const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const db = enabled ? connectDatabase(process.env.DATABASE_URL!) : undefined;
const exam = JSON.parse(
  readFileSync("public/downloads/example-exam.examprep.json", "utf8"),
);
const deck = JSON.parse(
  readFileSync("public/downloads/example-flashcards.examprep.json", "utf8"),
);
const emails: string[] = [];
function client() {
  let cookie = "";
  return async (path: string, method = "GET", body?: unknown, raw?: string) => {
    const options = {
      method,
      headers: {
        Origin: new URL(base).origin,
        Cookie: cookie,
        ...(body !== undefined || raw !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    };
    let response = await fetch(base + "/api" + path, options);
    if (response.status === 429) {
      const seconds = Number(response.headers.get("X-Retry-After") || 60);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(seconds, 60) * 1000 + 100),
      );
      response = await fetch(base + "/api" + path, options);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const value = (await response.json()) as any;
    return { status: response.status, value, headers: response.headers };
  };
}
describe.skipIf(!enabled)(
  "real Neon API acceptance (disposable test accounts only)",
  () => {
    const a = client(),
      b = client();
    const password = randomUUID() + "aB9!";
    let userId: string;
    beforeAll(async () => {
      for (const c of [a, b]) {
        const email = `acceptance-${randomUUID()}@example.test`;
        emails.push(email);
        const registered = await c("/auth/sign-up/email", "POST", {
          email,
          password,
          name: "Test",
        });
        expect(registered.status).toBe(200);
        if (c === a) userId = registered.value.user.id;
      }
    });
    afterAll(async () => {
      await db!.user.deleteMany({ where: { email: { in: emails } } });
      await db!.$disconnect();
    });
    it("organizes study sets without changing snapshot revisions and duplicates their content independently", async () => {
      const original = {
        ...exam,
        title: "Organization check exam",
      };
      const set = (await a("/sets", "POST", original)).value;
      const initial = (await a(`/sets/${set.id}/attempts`, "POST", {})).value;
      const organize = `/sets/${set.id}/organization`;
      const duplicate = `/sets/${set.id}/duplicate`;
      expect((await b(organize, "PATCH", { pinned: true })).status).toBe(404);
      expect((await b(duplicate, "POST", {})).status).toBe(404);
      expect(
        (await a(organize, "PATCH", { course: " Study skills ", pinned: true }))
          .status,
      ).toBe(200);
      const grouped = "/sets?course=Study%20skills&sort=studied";
      let library = (await a(grouped)).value;
      expect(library.courses).toContain("Study skills");
      expect(library.items[0]).toMatchObject({
        id: set.id,
        revision: 1,
        pinned: true,
        course: "Study skills",
        lastStudiedAt: expect.any(String),
        continuation: {
          id: initial.id,
          total: original.questions.length,
          isOlderVersion: false,
          kind: "exam",
        },
      });
      expect((await b(grouped)).value).toMatchObject({
        courses: [],
        items: [],
      });
      expect(
        (await a(`/sets/${set.id}`, "PUT", { revision: 1, content: original }))
          .value.revision,
      ).toBe(1);
      await a(`/attempts/${initial.id}/progress`, "PATCH", {
        revision: 1,
        position: original.questions.length - 1,
        changes: {},
      });
      expect(
        (
          await a(`/sets/${set.id}`, "PUT", {
            revision: 1,
            content: { ...original, questions: original.questions.slice(0, 1) },
          })
        ).status,
      ).toBe(200);
      library = (await a(grouped)).value;
      expect(library.items[0]).toMatchObject({
        count: 1,
        continuation: {
          id: initial.id,
          total: original.questions.length,
          isOlderVersion: true,
        },
      });
      const duplicated = await a(duplicate, "POST", {});
      expect(duplicated.status).toBe(201);
      expect(duplicated.value).toMatchObject({
        revision: 1,
        course: "Study skills",
        pinned: false,
        archived: false,
        lastStudiedAt: null,
        content: {
          title: "Copy of Organization check exam",
          questions: original.questions.slice(0, 1),
        },
      });
      expect(duplicated.value.id).not.toBe(set.id);
      await a(organize, "PATCH", { pinned: false });
      expect(
        (await a(grouped)).value.items.map(({ id }: { id: string }) => id),
      ).toEqual([set.id, duplicated.value.id]);
      await a(organize, "PATCH", { archived: true });
      expect(
        (await a(grouped)).value.items.map(({ id }: { id: string }) => id),
      ).toEqual([duplicated.value.id]);
      expect(
        (await a(grouped + "&archived=true")).value.items.map(
          ({ id }: { id: string }) => id,
        ),
      ).toEqual([set.id]);
    });
    it("enforces ownership, revisions, immutable snapshots, grading, retries, transitions, and idempotent submission", async () => {
      const unicode = {
        ...deck,
        title: "Unicode \0 \uD800 ~u0000; 🦊",
        cards: [{ id: "__proto__", front: "~ and \0", back: "\uD800" }],
      };
      const unicodeSet = (await a("/sets", "POST", unicode)).value;
      expect((await a(`/sets/${unicodeSet.id}/export`)).value).toEqual(unicode);
      await a(`/sets/${unicodeSet.id}`, "DELETE", { revision: 1 });
      // Prisma must not drop a contract-valid prototype-like map key.
      const specialSet = (
        await a("/sets", "POST", {
          schemaVersion: 1,
          kind: "flashcards",
          title: "Identity check",
          cards: [{ id: "__proto__", front: "x", back: "y" }],
        })
      ).value;
      const special = (await a(`/sets/${specialSet.id}/attempts`, "POST", {}))
        .value;
      const specialResponses = JSON.parse(
        '{"__proto__":{"revealed":true,"rating":"known"}}',
      );
      const specialSaved = await a(
        `/attempts/${special.id}/progress`,
        "PATCH",
        { revision: 1, position: 0, responses: specialResponses },
      );
      expect(specialSaved.status).toBe(200);
      expect(specialSaved.value.responses).toEqual(specialResponses);
      expect(
        (
          await a(`/attempts/${special.id}/submit`, "POST", {
            revision: specialSaved.value.revision,
          })
        ).value.result.known,
      ).toBe(1);
      await a(`/sets/${specialSet.id}`, "DELETE", { revision: 1 });
      const created = await a("/sets", "POST", exam);
      expect(created.status).toBe(201);
      const set = created.value;
      expect((await b("/sets")).value.items).toHaveLength(0);
      for (const [path, method, body] of [
        [`/sets/${set.id}`, "GET", undefined],
        [`/sets/${set.id}/export`, "GET", undefined],
        [`/sets/${set.id}`, "PUT", { revision: 1, content: exam }],
        [`/sets/${set.id}`, "DELETE", { revision: 1 }],
        [`/sets/${set.id}/attempts`, "POST", {}],
      ] as const)
        expect((await b(path, method, body)).status).toBe(404);
      const exported = await a(`/sets/${set.id}/export`);
      expect(exported.value).toEqual(exam);
      expect(exported.headers.get("Cache-Control")).toContain("no-store");
      const malformed = await a(
        "/sets",
        "POST",
        undefined,
        JSON.stringify(exam).replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        ),
      );
      expect(malformed.status).toBe(422);
      let attempt = (await a(`/sets/${set.id}/attempts`, "POST", {})).value;
      for (const [suffix, method, body] of [
        ["", "GET", undefined],
        ["/progress", "PATCH", { revision: 1, position: 0, responses: {} }],
        ["/submit", "POST", { revision: 1 }],
        ["/retry", "POST", {}],
      ] as const)
        expect(
          (await b(`/attempts/${attempt.id}${suffix}`, method, body)).status,
        ).toBe(404);
      expect((await b("/attempts")).value.items).toHaveLength(0);
      expect(
        (await a(`/attempts/${attempt.id}/retry`, "POST", {})).status,
      ).toBe(409);
      const answers = {
        q1: { selectedOptionId: "b" },
        q2: { text: "working" },
        q3: { text: "zero" },
      };
      const saves = await Promise.all(
        [1, 2].map(() =>
          a(`/attempts/${attempt.id}/progress`, "PATCH", {
            revision: 1,
            position: 1,
            responses: answers,
          }),
        ),
      );
      expect(saves.map((r) => r.status).sort()).toEqual([200, 409]);
      attempt = saves.find((r) => r.status === 200)!.value;
      const otherDevice = client();
      expect(
        (
          await otherDevice("/auth/sign-in/email", "POST", {
            email: emails[0],
            password,
          })
        ).status,
      ).toBe(200);
      const resumed = await otherDevice(`/attempts/${attempt.id}`);
      expect(resumed.value.responses).toEqual(answers);
      expect(resumed.value.position).toBe(1);
      const submissions = await Promise.all(
        [1, 2].map(() =>
          a(`/attempts/${attempt.id}/submit`, "POST", {
            revision: attempt.revision,
          }),
        ),
      );
      expect(submissions.every((r) => r.status === 200)).toBe(true);
      expect(submissions[0].value.revision).toBe(submissions[1].value.revision);
      attempt = submissions[0].value;
      expect(attempt.status).toBe("reviewing");
      expect(
        (
          await a(`/attempts/${attempt.id}/progress`, "PATCH", {
            revision: attempt.revision,
            position: 1,
            responses: { ...answers, q2: { text: "changed" } },
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await a(`/attempts/${attempt.id}/progress`, "PATCH", {
            revision: attempt.revision,
            position: 1,
            responses: {
              ...answers,
              q2: { text: "working", criterionPoints: { rule: 3 } },
            },
          })
        ).status,
      ).toBe(422);
      const assessed = {
        ...answers,
        q2: { text: "working", criterionPoints: { rule: 1, result: 2 } },
        q3: { text: "zero", selfAssessment: "correct" },
      };
      attempt = (
        await a(`/attempts/${attempt.id}/progress`, "PATCH", {
          revision: attempt.revision,
          position: 1,
          responses: assessed,
        })
      ).value;
      expect(attempt.status).toBe("completed");
      expect(attempt.result.automatic.earnedPoints).toBe(1);
      expect(attempt.result.selfAssessed).toEqual({
        earnedPoints: 4,
        maxPoints: 6,
        pendingCount: 0,
      });
      expect(
        (
          await a(`/attempts/${attempt.id}/progress`, "PATCH", {
            revision: attempt.revision,
            position: 0,
            responses: assessed,
          })
        ).status,
      ).toBe(422);
      const repeated = await a(`/attempts/${attempt.id}/submit`, "POST", {
        revision: 1,
      });
      expect(repeated.value).toEqual(attempt);
      const annotation = { ...assessed.q2, flagged: true, confidence: "low", note: "Revisit the reasoning." };
      const noted = await a(`/attempts/${attempt.id}/progress`, "PATCH", {
        revision: attempt.revision,
        position: 0,
        changes: { q2: annotation },
      });
      expect(noted.status).toBe(200);
      expect(noted.value).toMatchObject({
        status: "completed", position: attempt.position, result: attempt.result,
        revision: attempt.revision + 1, completedAt: attempt.completedAt,
      });
      expect((await a(`/attempts/${attempt.id}`)).value.responses.q2).toEqual(annotation);
      await expect(db!.$executeRaw`
        UPDATE "Attempt" SET responses = jsonb_set(responses, '{q2,text}', '"tampered"'), revision = revision + 1
        WHERE id = ${attempt.id}
      `).rejects.toThrow(/Completed answers are read-only/);
      const changed = { ...exam, title: "Edited source" };
      expect(
        (await a(`/sets/${set.id}`, "PUT", { revision: 1, content: changed }))
          .status,
      ).toBe(200);
      expect(
        (await a(`/sets/${set.id}`, "PUT", { revision: 1, content: exam }))
          .status,
      ).toBe(409);
      expect((await a(`/attempts/${attempt.id}`)).value.snapshot).toEqual(exam);
      expect(
        (await a(`/sets/${set.id}`, "DELETE", { revision: 2 })).status,
      ).toBe(200);
      const historical = (await a(`/attempts/${attempt.id}`)).value;
      expect(historical.studySetId).toBeNull();
      expect(historical.snapshot).toEqual(exam);
      const retry = await a(`/attempts/${attempt.id}/retry`, "POST", {});
      expect(retry.status).toBe(201);
      expect(retry.value.snapshot.questions).toEqual([exam.questions[1]]);
      expect(retry.value.responses).toEqual({});
      expect(retry.value.result).toBeNull();
      expect(retry.value.sourceAttemptId).toBe(attempt.id);
      expect(
        (await a(`/attempts/${retry.value.id}/submit`, "POST", { revision: 1 }))
          .value.status,
      ).toBe("completed");
      expect((await a(`/attempts/${attempt.id}`)).value.result).toEqual(
        attempt.result,
      );
      await expect(
        db!.attempt.update({
          where: { id: attempt.id },
          data: { snapshot: changed },
        }),
      ).rejects.toThrow();
      await expect(
        db!.attempt.update({
          where: { id: attempt.id },
          data: { responses: {} },
        }),
      ).rejects.toThrow();
      expect((await a("/sets", "POST", { ...exam, userId })).status).toBe(422);
      const forbidden = await fetch(base + "/api/sets", {
        method: "POST",
        headers: {
          Origin: "https://attacker.invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(exam),
      });
      expect(forbidden.status).toBe(403);
    }, 120000);
    it("persists flashcard reveal/rating, validates early completion, and selects exactly Review again", async () => {
      const set = (await a("/sets", "POST", deck)).value;
      let attempt = (await a(`/sets/${set.id}/attempts`, "POST", {})).value;
      const path = `/attempts/${attempt.id}`;
      expect(
        (
          await a(path + "/progress", "PATCH", {
            revision: 1,
            position: 0,
            responses: { c1: { revealed: false, rating: "known" } },
          })
        ).status,
      ).toBe(422);
      attempt = (
        await a(path + "/progress", "PATCH", {
          revision: 1,
          position: 0,
          responses: { c1: { revealed: true, rating: "review_again" } },
        })
      ).value;
      attempt = (
        await a(path + "/submit", "POST", { revision: attempt.revision })
      ).value;
      expect(attempt.result).toEqual({
        known: 0,
        reviewAgain: 1,
        unreviewed: 1,
      });
      const retry = (await a(path + "/retry", "POST", {})).value;
      expect(retry.snapshot.cards).toEqual([deck.cards[0]]);
      expect(retry.responses).toEqual({});
      const emptyRetry = (await a(`/sets/${set.id}/attempts`, "POST", {}))
        .value;
      await a(`/attempts/${emptyRetry.id}/submit`, "POST", { revision: 1 });
      expect(
        (await a(`/attempts/${emptyRetry.id}/retry`, "POST", {})).status,
      ).toBe(422);
    }, 60000);
    it("paginates owned metadata without transferring content or response snapshots", async () => {
      const documents = Array.from({ length: 31 }, (_, n) => {
        const content = { ...deck, title: `Pagination ${n}` };
        return {
          id: randomUUID(),
          userId,
          title: content.title,
          kind: content.kind,
          content,
        };
      });
      await db!.studySet.createMany({ data: documents });
      const first = (await a("/sets?kind=flashcards&page=0")).value;
      const second = (await a("/sets?kind=flashcards&page=1")).value;
      expect(first.items).toHaveLength(30);
      expect(first.hasMore).toBe(true);
      expect(second.hasMore).toBe(false);
      expect(
        [...first.items, ...second.items].filter((s: { title: string }) =>
          s.title.startsWith("Pagination "),
        ),
      ).toHaveLength(31);
      expect(
        first.items.every((s: object) => !Object.hasOwn(s, "content")),
      ).toBe(true);
      expect((await b("/sets?kind=flashcards")).value.items).toHaveLength(0);
      const found = (await a("/sets?kind=flashcards&search=Pagination%2030"))
        .value;
      expect(found.items.map((s: { title: string }) => s.title)).toEqual([
        "Pagination 30",
      ]);
      expect(
        (await a("/sets?kind=exam&search=Pagination%2030")).value.items,
      ).toHaveLength(0);
      const source = documents[0];
      const records = Array.from({ length: 31 }, () => ({
        id: randomUUID(),
        userId,
        studySetId: source.id,
        snapshot: source.content,
      }));
      await db!.attempt.createMany({ data: records });
      const continued = (
        await a(`/sets?search=${encodeURIComponent(source.title)}`)
      ).value.items.find((s: { id: string }) => s.id === source.id);
      expect(records.some((r) => r.id === continued.continuation.id)).toBe(
        true,
      );
      expect(
        (await a(`/attempts?status=completed&setId=${source.id}`)).value.items,
      ).toHaveLength(0);
      expect(
        (
          await a(
            `/attempts?status=attention&setId=${source.id}&search=Pagination`,
          )
        ).value.items,
      ).toHaveLength(30);
      const history1 = (await a("/attempts?page=0")).value;
      const history2 = (await a("/attempts?page=1")).value;
      expect(history1.items).toHaveLength(30);
      expect(history1.hasMore).toBe(true);
      expect(history2.hasMore).toBe(false);
      const ids = new Set<string>(records.map((r) => r.id));
      expect(
        [...history1.items, ...history2.items].filter((r: { id: string }) =>
          ids.has(r.id),
        ),
      ).toHaveLength(31);
      expect(
        history1.items.every(
          (r: object) =>
            !Object.hasOwn(r, "snapshot") && !Object.hasOwn(r, "responses"),
        ),
      ).toBe(true);
      expect((await b("/attempts")).value.items).toHaveLength(0);
    }, 60000);
    it("uses database hashing for long Unicode passwords and preserves legacy accounts during migration", async () => {
      const c = client();
      const email = `acceptance-password-${randomUUID()}@example.test`;
      emails.push(email);
      // More than bcrypt's 72-byte input limit; suffixes must remain significant.
      const longPassword = "🦊".repeat(40) + "café";
      const registered = await c("/auth/sign-up/email", "POST", {
        email,
        password: longPassword,
        name: "Password test",
      });
      expect(registered.status).toBe(200);
      const id = registered.value.user.id;
      const original = await db!.account.findFirstOrThrow({
        where: { userId: id, providerId: "credential" },
      });
      expect(original.password).toMatch(PASSWORD_PATTERN);
      expect(original.password).not.toContain(longPassword);
      const callbacks = databasePasswords(
        db!,
        process.env.PASSWORD_PEPPER!,
        "worker",
      );
      expect(
        await callbacks.verify({
          hash: original.password!,
          password: longPassword,
        }),
      ).toBe(true);
      expect(
        await callbacks.verify({
          hash: original.password!,
          password: longPassword + "x",
        }),
      ).toBe(false);
      expect(
        await databasePasswords(
          db!,
          process.env.PASSWORD_PEPPER! + "x",
          "worker",
        ).verify({ hash: original.password!, password: longPassword }),
      ).toBe(false);
      const again = await callbacks.hash(longPassword);
      expect(again).not.toBe(original.password);
      expect(
        await callbacks.verify({ hash: again, password: longPassword }),
      ).toBe(true);
      const set = (await c("/sets", "POST", deck)).value;
      await c("/auth/sign-out", "POST", {});
      expect(
        (
          await c("/auth/sign-in/email", "POST", {
            email,
            password: longPassword + "x",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await c("/auth/sign-in/email", "POST", {
            email,
            password: longPassword,
          })
        ).status,
      ).toBe(200);
      await c("/auth/sign-out", "POST", {});
      const salt = "0123456789abcdef0123456789abcdef";
      const legacy =
        salt +
        ":" +
        scryptSync(longPassword.normalize("NFKC"), salt, 64, {
          N: 16384,
          r: 16,
          p: 1,
          maxmem: 67108864,
        }).toString("hex");
      await db!.account.update({
        where: { id: original.id },
        data: { password: legacy },
      });
      const runtime = (await c("/health")).value.runtime;
      const login = await c("/auth/sign-in/email", "POST", {
        email,
        password: longPassword,
      });
      if (runtime === "worker") {
        expect(login.status).toBe(503);
        expect(login.value.code).toBe("PASSWORD_MIGRATION_REQUIRED");
        expect(
          (await db!.account.findUniqueOrThrow({ where: { id: original.id } }))
            .password,
        ).toBe(legacy);
        // Exercise the Node migration callback locally, then prove the Worker
        // accepts its new hash while retaining exactly the same owner/content.
        expect(
          await databasePasswords(
            db!,
            process.env.PASSWORD_PEPPER!,
            "node",
          ).verify({ hash: legacy, password: longPassword }),
        ).toBe(true);
        expect(
          (
            await c("/auth/sign-in/email", "POST", {
              email,
              password: longPassword,
            })
          ).status,
        ).toBe(200);
      } else {
        expect(login.status).toBe(200);
        expect(login.value.user.id).toBe(id);
      }
      expect(
        (await db!.account.findUniqueOrThrow({ where: { id: original.id } }))
          .password,
      ).toMatch(PASSWORD_PATTERN);
      expect((await c(`/sets/${set.id}`)).value.userId).toBe(id);
      expect((await c(`/sets/${set.id}/export`)).value).toEqual(deck);
    }, 120000);
    it("schedules rated cards, serializes due starts, and requeues edited card text", async () => {
      const content = {
        schemaVersion: 1,
        kind: "flashcards",
        title: "Review schedule",
        cards: [
          { id: "first", front: "One", back: "Uno" },
          { id: "second", front: "Two", back: "Dos" },
        ],
      };
      const set = (await a("/sets", "POST", content)).value;
      const review = `/sets/${set.id}/review`;
      expect((await b(review)).status).toBe(404);
      expect((await a(review, "PATCH", { limit: 1 })).value).toMatchObject({ due: 2, available: 1 });
      const starts = await Promise.all([a(review, "POST", {}), a(review, "POST", {})]);
      expect(starts.map((response) => response.status).sort()).toEqual([200, 201]);
      expect(starts[0].value.id).toBe(starts[1].value.id);
      const path = `/attempts/${starts[0].value.id}`;
      expect((await a(path)).value).toMatchObject({ reviewMode: true, snapshot: { cards: [content.cards[0]] } });
      expect((await a(review, "PATCH", { limit: 2 })).status).toBe(409);
      const saved = await a(path + "/progress", "PATCH", {
        revision: 1, position: 0, changes: { first: { revealed: true, rating: "known" } },
      });
      expect(saved.status).toBe(200);
      const submitted = await a(path + "/submit", "POST", { revision: saved.value.revision });
      expect(submitted.status).toBe(200);
      const queue = (await a(review)).value;
      expect(queue).toMatchObject({ reviewedToday: 1, due: 1, available: 0, activeAttemptId: null });
      expect(queue.cards[0]).toMatchObject({ due: false, nextReviewAt: expect.any(String) });
      expect((await a(review, "POST", {})).status).toBe(409);
      const edited = { ...content, cards: [{ ...content.cards[0], back: "Una" }, content.cards[1]] };
      expect((await a(`/sets/${set.id}`, "PUT", { revision: set.revision, content: edited })).status).toBe(200);
      expect((await a(review)).value.cards[0]).toMatchObject({ due: true, nextReviewAt: null });
    }, 120000);
    it("compares full exams by revision and surfaces pending and recurring work", async () => {
      const content = {
        schemaVersion: 1,
        kind: "exam",
        title: "Comparable exam",
        questions: [
          { id: "q1", type: "single_choice", prompt: "Count electrons", options: [{ id: "a", text: "One" }, { id: "b", text: "Two" }], answer: "b" },
          { id: "q2", type: "written", prompt: "Explain the rule", answer: "Reference" },
        ],
      };
      const set = (await a("/sets", "POST", content)).value;
      const sessions = [];
      for (let i = 0; i < 3; i++) {
        const attempt = (await a(`/sets/${set.id}/attempts`, "POST", {})).value;
        const path = `/attempts/${attempt.id}`;
        const saved = (await a(path + "/progress", "PATCH", {
          revision: 1, position: 0, changes: { q1: { selectedOptionId: "a" }, q2: { text: "My response" } },
        })).value;
        const submitted = (await a(path + "/submit", "POST", { revision: saved.revision })).value;
        expect(submitted.status).toBe("reviewing");
        if (i < 2) {
          const assessed = await a(path + "/progress", "PATCH", {
            revision: submitted.revision, position: 0, changes: { q2: { text: "My response", selfAssessment: "correct" } },
          });
          expect(assessed.value.status).toBe("completed");
        }
        sessions.push(attempt.id);
      }
      const subset = (await a(`/sets/${set.id}/attempts`, "POST", { count: 1 })).value;
      expect((await a(`/attempts/${subset.id}/submit`, "POST", { revision: 1 })).status).toBe(200);
      const insights = await a(`/insights?setId=${set.id}`);
      expect(insights.status).toBe(200);
      expect(insights.value.trends).toHaveLength(1);
      expect(insights.value.trends[0].scores.map((score: { id: string }) => score.id)).toEqual(sessions.slice(0, 2));
      expect(insights.value.trends[0].scores[0].result).toMatchObject({
        automatic: { earnedPoints: 0, maxPoints: 1 }, selfAssessed: { earnedPoints: 1, maxPoints: 1 },
      });
      expect(insights.value.pending).toMatchObject({ attemptId: sessions[2], answers: 1 });
      expect(insights.value.recurring).toEqual([expect.objectContaining({ itemId: "q1", prompt: "Count electrons", misses: 3 })]);
      expect((await b(`/insights?setId=${set.id}`)).value).toEqual({ trends: [], recurring: [], pending: null, retry: null });
    }, 120000);
    it("changes password, revokes other sessions, and expires logout sessions", async () => {
      const other = client();
      expect(
        (
          await other("/auth/sign-in/email", "POST", {
            email: emails[0],
            password,
          })
        ).status,
      ).toBe(200);
      const updated = randomUUID() + "zZ9!";
      expect(
        (
          await a("/auth/change-password", "POST", {
            currentPassword: "incorrect-password",
            newPassword: updated,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await a("/auth/change-password", "POST", {
            currentPassword: password,
            newPassword: updated,
            revokeOtherSessions: true,
          })
        ).status,
      ).toBe(200);
      expect((await other("/sets")).status).toBe(401);
      expect((await a("/auth/sign-out", "POST", {})).status).toBe(200);
      expect((await a("/sets")).status).toBe(401);
      expect(
        (
          await a("/auth/sign-in/email", "POST", {
            email: emails[0],
            password: updated,
          })
        ).status,
      ).toBe(200);
    }, 120000);
  },
);
