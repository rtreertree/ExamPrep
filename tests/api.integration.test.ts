import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { neonConfig } from "@neondatabase/serverless";
import { Prisma } from "../generated/prisma/client";
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
    it("shares the latest saved exam through revocable copy links and imports each action once", async () => {
      const create = await a("/sets", "POST", {
        ...exam,
        title: "Copy link exam",
      });
      expect(create.value).toMatchObject({
        ownershipRole: "primary",
        revision: 1,
      });
      const path = `/sets/${create.value.id}`;
      expect((await b(path)).status).toBe(404);
      expect((await b(path + "/sharing")).status).toBe(404);
      expect(
        (await b(path + "/sharing/link", "PUT", { enabled: true })).status,
      ).toBe(404);
      const enabled = await a(path + "/sharing/link", "PUT", { enabled: true });
      expect(enabled.value.link).toMatch(/^\/share#/);
      expect((await a(path + "/sharing")).value.link).toBe(enabled.value.link);
      const token = enabled.value.link.split("#")[1];
      const guest = client();
      expect((await guest("/shares/preview", "POST", { token })).status).toBe(
        401,
      );
      expect(
        (await b("/shares/preview", "POST", { token: token.slice(0, -1) }))
          .status,
      ).toBe(404);
      const preview = await b("/shares/preview", "POST", { token });
      expect(preview.value).toEqual({
        title: "Copy link exam",
        kind: "exam",
        count: exam.questions.length,
      });
      expect(preview.headers.get("Cache-Control")).toBe("no-store, private");
      const updated = { ...exam, title: "Copy link exam updated" };
      expect(
        (await a(path, "PUT", { revision: 1, content: updated })).status,
      ).toBe(200);
      const importBody = { token, requestId: randomUUID() };
      const concurrent = await Promise.all([
        b("/shares/import", "POST", importBody),
        b("/shares/import", "POST", importBody),
      ]);
      expect(concurrent.map(({ status }) => status).sort()).toEqual([200, 201]);
      const copy = concurrent[0].value.id;
      expect(concurrent[1].value.id).toBe(copy);
      expect(copy).not.toBe(create.value.id);
      expect((await b(`/sets/${copy}`)).value).toMatchObject({
        ownershipRole: "primary",
        revision: 1,
        content: updated,
        course: "",
        pinned: false,
        archived: false,
        lastStudiedAt: null,
      });
      expect((await a(`/sets/${copy}`)).status).toBe(404);
      expect((await b(path)).status).toBe(404);
      const another = await b("/shares/import", "POST", {
        token,
        requestId: randomUUID(),
      });
      expect(another.status).toBe(201);
      expect(another.value.id).not.toBe(copy);
      expect(
        (await a(path + "/sharing/link", "PUT", { enabled: false })).value.link,
      ).toBeNull();
      expect((await b("/shares/preview", "POST", { token })).status).toBe(404);
      expect(
        (await b("/shares/import", "POST", { token, requestId: randomUUID() }))
          .status,
      ).toBe(404);
      expect((await b("/shares/import", "POST", importBody)).value.id).toBe(
        copy,
      );
      const reenabled = await a(path + "/sharing/link", "PUT", {
        enabled: true,
      });
      expect(reenabled.value.link).not.toBe(enabled.value.link);
      expect((await b("/shares/preview", "POST", { token })).status).toBe(404);
      const invited = await a(path + "/sharing/invitations", "POST", {
        email: emails[1],
      });
      const invitationId = invited.value.invitations[0].id;
      const accepted = await b(`/ownership-invitations/${invitationId}/respond`, "POST", {
        accept: true,
      });
      expect(accepted.status).toBe(200);
      expect((await b(path)).value).toMatchObject({
        ownershipRole: "co_owner",
        content: updated,
      });
      expect((await a(path, "DELETE", { revision: 2 })).status).toBe(200);
      expect((await b(path)).status).toBe(404);
      expect(
        (
          await b("/shares/preview", "POST", {
            token: reenabled.value.link.split("#")[1],
          })
        ).status,
      ).toBe(404);
      expect((await b(`/sets/${copy}`, "DELETE", { revision: 1 })).status).toBe(
        200,
      );
      expect((await b("/shares/import", "POST", importBody)).status).toBe(404);
      await b(`/sets/${another.value.id}`, "DELETE", { revision: 1 });
    }, 60000);

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
    it("browses courses by archive scope and applies organization batches atomically", async () => {
      const course = `Course ${randomUUID()}`;
      const created = await Promise.all([
        a("/sets", "POST", { ...exam, title: "Bulk organization exam" }),
        a("/sets", "POST", { ...deck, title: "Bulk organization deck" }),
        b("/sets", "POST", { ...exam, title: "Another account's set" }),
      ]);
      const [first, second, foreign] = created.map(({ value }) => value);
      const path = "/sets/organization";
      try {
        const failed = await a(path, "PATCH", {
          ids: [first.id, foreign.id],
          course,
        });
        expect(failed.status).toBe(404);
        expect((await a(`/sets/${first.id}`)).value.course).toBe("");
        expect((await b(`/sets/${foreign.id}`)).value.course).toBe("");
        expect(
          (await a(path, "PATCH", { ids: [first.id, first.id], pinned: true }))
            .status,
        ).toBe(422);
        const changes = {
          ids: [first.id, second.id],
          course: ` ${course} `,
          pinned: true,
        };
        expect((await a(path, "PATCH", changes)).value).toEqual({ updated: 2 });
        expect((await a(path, "PATCH", changes)).value).toEqual({ updated: 0 });
        expect((await a(`/sets/${first.id}`)).value).toMatchObject({
          revision: 1,
          course,
          pinned: true,
        });
        expect((await a("/sets/courses")).value.items).toContainEqual({
          course,
          count: 2,
        });
        expect((await b("/sets/courses")).value.items).not.toContainEqual(
          expect.objectContaining({ course }),
        );
        expect(
          (await a(path, "PATCH", { ids: [second.id], archived: true })).value,
        ).toEqual({ updated: 1 });
        expect((await a("/sets/courses")).value.items).toContainEqual({
          course,
          count: 1,
        });
        expect(
          (await a("/sets/courses?archived=true")).value.items,
        ).toContainEqual({ course, count: 1 });
        expect(
          (
            await a(path, "PATCH", {
              ids: [second.id],
              archived: false,
              course: "",
            })
          ).value,
        ).toEqual({ updated: 1 });
        expect((await a("/sets/courses")).value.items).toContainEqual(
          expect.objectContaining({ course: "" }),
        );
      } finally {
        await db!.studySet.deleteMany({
          where: { id: { in: [first.id, second.id, foreign.id] } },
        });
      }
    }, 60000);
    it("filters and pages History by attempts and by study set", async () => {
      const title = `Grouped history ${randomUUID()}`;
      const sets = Array.from({ length: 32 }, (_, index) => {
        const content = { ...deck, title: `${title} ${index}` };
        return {
          id: randomUUID(),
          userId,
          content,
          title: content.title,
          kind: content.kind,
        };
      });
      const [renamed, deleted] = sets;
      const from = "2026-11-01T04:00:00.000Z";
      const before = "2026-11-03T05:00:00.000Z";
      const groups = sets.map((set, index) => ({
        id: randomUUID(),
        userId,
        studySetId: set.id,
        snapshot: set.content,
        status: "completed",
        startedAt: new Date(Date.parse(from) + index * 1000),
        completedAt: new Date(before),
        result: {},
      }));
      const extra = Array.from({ length: 30 }, () => ({
        ...groups[0],
        id: randomUUID(),
        startedAt: new Date("2026-11-02T13:00:00.000Z"),
      }));
      const excluded = [
        {
          ...groups[0],
          id: randomUUID(),
          startedAt: new Date(Date.parse(from) - 1),
        },
        { ...groups[0], id: randomUUID(), startedAt: new Date(before) },
        {
          ...groups[0],
          id: randomUUID(),
          status: "in_progress",
          completedAt: null,
          result: Prisma.DbNull,
        },
        { ...groups[0], id: randomUUID(), reviewMode: true },
        { ...groups[0], id: randomUUID(), snapshot: { ...exam, title } },
      ];
      const records = [...groups, ...extra, ...excluded];
      await db!.studySet.createMany({ data: sets });
      try {
        await db!.attempt.createMany({ data: records });
        const currentTitle = "Current study-set title";
        await db!.studySet.update({
          where: { id: renamed.id },
          data: {
            title: currentTitle,
            content: { ...renamed.content, title: currentTitle },
            revision: 2,
          },
        });
        await db!.studySet.delete({ where: { id: deleted.id } });
        const filter = new URLSearchParams({
          search: title,
          status: "completed",
          type: "flashcards",
          startedFrom: from,
          startedBefore: before,
        });
        const groupPath = `/attempts/groups?${filter}`;
        const first = (await a(groupPath)).value;
        const second = (await a(groupPath + "&page=1")).value;
        expect(first.hasMore).toBe(true);
        expect(first.items).toHaveLength(30);
        expect(first.items[0]).toMatchObject({
          setId: renamed.id,
          title: currentTitle,
          count: 31,
        });
        expect(
          (
            await a(
              `/attempts/groups?search=${encodeURIComponent(currentTitle)}`,
            )
          ).value.items,
        ).toEqual([
          expect.objectContaining({ setId: renamed.id, title: currentTitle }),
        ]);
        expect(second).toMatchObject({
          hasMore: false,
          items: expect.arrayContaining([
            {
              setId: null,
              title: null,
              count: 1,
              latestStartedAt: expect.any(String),
            },
          ]),
        });
        expect(second.items).toHaveLength(2);
        expect((await b(groupPath)).value.items).toEqual([]);
        const attemptPath = `/attempts?${filter}&setId=${renamed.id}`;
        expect((await a(attemptPath)).value).toMatchObject({ hasMore: true });
        expect((await a(attemptPath + "&page=1")).value).toMatchObject({
          hasMore: false,
          items: [{ id: groups[0].id }],
        });
        expect(
          (await a(`/attempts?${filter}&unlinked=true`)).value.items,
        ).toMatchObject([{ title: deleted.title }]);
        filter.set("type", "spaced");
        expect((await a(`/attempts?${filter}`)).value.items).toMatchObject([
          { id: excluded[3].id },
        ]);
        expect((await a("/attempts/groups?type=other")).status).toBe(400);
        expect(
          (await a("/attempts?startedFrom=2026-02-30T00:00:00Z")).status,
        ).toBe(400);
      } finally {
        await db!.attempt.deleteMany({
          where: { id: { in: records.map(({ id }) => id) } },
        });
        await db!.studySet.deleteMany({
          where: { id: { in: sets.map(({ id }) => id) } },
        });
      }
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
    it("lets accepted co-owners study and edit one deck with private schedules, settings and backups", async () => {
      const collaborator = client();
      const collaboratorEmail = `acceptance-${randomUUID()}@example.test`;
      emails.push(collaboratorEmail);
      const registered = await collaborator("/auth/sign-up/email", "POST", {
        email: collaboratorEmail,
        password,
        name: "Test",
      });
      expect(registered.status).toBe(200);
      const coOwner = registered.value.user;
      const stranger = b;
      const document = {
        ...deck,
        title: "Co-owned test deck",
        cards: deck.cards.slice(0, 2),
      };
      const original = (await a("/sets", "POST", document)).value;
      const path = `/sets/${original.id}`;
      const invitations = "/ownership-invitations";
      const invite = (email: string) =>
        a(path + "/sharing/invitations", "POST", { email });
      const respond = (id: string) => `${invitations}/${id}/respond`;
      expect((await invite(emails[0])).status).toBe(409);
      expect((await invite(`absent-${randomUUID()}@example.test`)).status).toBe(
        404,
      );
      const first = (await invite(coOwner.email.toUpperCase())).value
        .invitations[0].id;
      expect((await invite(coOwner.email)).value.invitations).toEqual([
        { id: first, email: coOwner.email },
      ]);
      expect((await collaborator(path)).status).toBe(404);
      expect((await stranger(invitations)).value).toEqual([]);
      expect(
        (await stranger(respond(first), "POST", { accept: true })).status,
      ).toBe(404);
      expect(
        (await a(path + `/sharing/invitations/${first}`, "DELETE", {})).status,
      ).toBe(200);
      expect(
        (await collaborator(respond(first), "POST", { accept: true })).status,
      ).toBe(404);
      const second = (await invite(coOwner.email)).value.invitations[0].id;
      expect(
        (await collaborator(respond(second), "POST", { accept: false })).value
          .accepted,
      ).toBe(false);
      const third = (await invite(coOwner.email)).value.invitations[0].id;
      expect((await collaborator(invitations)).value).toEqual([
        {
          id: third,
          title: document.title,
          kind: "flashcards",
          ownerEmail: emails[0],
        },
      ]);
      expect(
        (await collaborator(respond(third), "POST", { accept: true })).value,
      ).toEqual({ studySetId: original.id, accepted: true });
      expect((await collaborator(path)).value).toMatchObject({
        ownershipRole: "co_owner",
        content: document,
        lastStudiedAt: null,
      });
      expect((await collaborator(path + "/sharing")).status).toBe(404);
      expect(
        (await collaborator(path + "/sharing/link", "PUT", { enabled: true }))
          .status,
      ).toBe(404);
      expect((await collaborator(path, "DELETE", { revision: 1 })).status).toBe(
        404,
      );
      expect((await stranger(path)).status).toBe(404);
      expect((await stranger(path + "/export")).status).toBe(404);
      expect((await stranger(path + "/attempts", "POST", {})).status).toBe(404);

      const revised = { ...document, title: "Co-owned revised deck" };
      expect(
        (await collaborator(path, "PUT", { revision: 1, content: revised }))
          .value.revision,
      ).toBe(2);
      expect(
        (await a(path, "PUT", { revision: 1, content: document })).status,
      ).toBe(409);
      expect((await collaborator(path + "/export")).value).toEqual(revised);
      expect((await a(path)).value).toMatchObject({
        content: revised,
        course: "",
        pinned: false,
      });
      const duplicate = await collaborator(path + "/duplicate", "POST", {});
      expect(duplicate.value.ownershipRole).toBe("primary");
      await collaborator(`/sets/${duplicate.value.id}`, "DELETE", {
        revision: 1,
      });
      expect(
        (
          await collaborator("/sets/organization", "PATCH", {
            ids: [original.id],
            course: "Private co-owner course",
            pinned: true,
          })
        ).value.updated,
      ).toBe(1);
      expect((await collaborator("/sets/courses")).value.items).toContainEqual({
        course: "Private co-owner course",
        count: 1,
      });
      expect((await a("/sets/courses")).value.items).not.toContainEqual({
        course: "Private co-owner course",
        count: 1,
      });
      expect(
        (await collaborator("/sets?course=Private%20co-owner%20course")).value
          .items[0],
      ).toMatchObject({
        id: original.id,
        ownershipRole: "co_owner",
        pinned: true,
      });
      expect(
        (
          await collaborator(path + "/organization", "PATCH", {
            archived: true,
          })
        ).status,
      ).toBe(200);
      expect((await collaborator(path + "/review")).value.archived).toBe(true);
      expect((await a(path + "/review")).value.archived).toBe(false);
      await collaborator(path + "/organization", "PATCH", { archived: false });

      expect(
        (await collaborator(path + "/review", "PATCH", { limit: 1 })).value
          .limit,
      ).toBe(1);
      expect((await a(path + "/review")).value.limit).toBe(20);
      const review = (await collaborator(path + "/review", "POST", {})).value
        .id;
      const ownerAttempt = (await a(path + "/attempts", "POST", {})).value.id;
      expect((await a(`/attempts/${review}`)).status).toBe(404);
      expect((await collaborator(`/attempts/${ownerAttempt}`)).status).toBe(
        404,
      );
      const cardId = document.cards[0].id;
      const saved = await collaborator(
        `/attempts/${review}/progress`,
        "PATCH",
        {
          revision: 1,
          position: 0,
          responses: {
            [cardId]: {
              revealed: true,
              rating: "known",
              note: "Private co-owner note",
            },
          },
        },
      );
      expect(saved.status).toBe(200);
      expect(
        (
          await collaborator(`/attempts/${review}/submit`, "POST", {
            revision: saved.value.revision,
          })
        ).status,
      ).toBe(200);
      expect((await collaborator(path + "/review")).value).toMatchObject({
        due: 1,
        reviewedToday: 1,
      });
      expect((await a(path + "/review")).value).toMatchObject({
        due: 2,
        reviewedToday: 0,
      });
      const enabledLink = await a(path + "/sharing/link", "PUT", {
        enabled: true,
      });
      const token = enabledLink.value.link.split("#")[1];
      const preview = await stranger("/shares/preview", "POST", { token });
      expect(preview.value).toEqual({
        title: revised.title,
        kind: "flashcards",
        count: 2,
      });
      const imported = await stranger("/shares/import", "POST", {
        token,
        requestId: randomUUID(),
      });
      expect(imported.status).toBe(201);
      const importedPath = `/sets/${imported.value.id}`;
      expect((await stranger(importedPath)).value).toMatchObject({
        ownershipRole: "primary",
        content: revised,
        lastStudiedAt: null,
        reviewLimit: 20,
      });
      expect((await stranger(importedPath, "DELETE", { revision: 1 })).status).toBe(200);
      expect(
        (await collaborator(`/attempts/groups?setId=${original.id}`)).value
          .items[0],
      ).toMatchObject({
        setId: original.id,
        title: revised.title,
        count: 1,
      });

      const coBackup = await collaborator("/backup?history=1");
      const primaryBackup = await a("/backup?history=1");
      expect(coBackup.value.library.sets).toContainEqual(
        expect.objectContaining({
          id: original.id,
          course: "Private co-owner course",
        }),
      );
      expect(coBackup.value.history.reviews).toContainEqual(
        expect.objectContaining({ studySetId: original.id, cardId }),
      );
      expect(primaryBackup.value.history.reviews).not.toContainEqual(
        expect.objectContaining({ studySetId: original.id }),
      );
      expect(primaryBackup.value.history.attempts).not.toContainEqual(
        expect.objectContaining({ id: review }),
      );
      const coSet = coBackup.value.library.sets.find(
        ({ id }: { id: string }) => id === original.id,
      );
      const restored = await collaborator("/backup/restore", "POST", {
        library: { ...coBackup.value.library, sets: [coSet] },
        history: {
          ...coBackup.value.history,
          attempts: coBackup.value.history.attempts.filter(
            ({ studySetId }: { studySetId: string }) =>
              studySetId === original.id,
          ),
          reviews: coBackup.value.history.reviews.filter(
            ({ studySetId }: { studySetId: string }) =>
              studySetId === original.id,
          ),
        },
      });
      expect(restored.value).toMatchObject({
        setCount: 1,
        attemptCount: 1,
        reviewCount: 1,
      });
      const copy = (
        await collaborator("/sets?course=Private%20co-owner%20course")
      ).value.items.find(({ id }: { id: string }) => id !== original.id);
      expect(copy.ownershipRole).toBe("primary");
      expect((await collaborator(`/sets/${copy.id}/sharing`)).value).toEqual({
        link: null,
        coOwners: [],
        invitations: [],
      });
      expect((await collaborator(`/sets/${copy.id}/review`)).value.due).toBe(1);

      expect(
        (await a(path + `/sharing/co-owners/${coOwner.id}`, "DELETE", {}))
          .status,
      ).toBe(200);
      expect((await collaborator(path)).status).toBe(404);
      expect((await collaborator(path + "/review")).status).toBe(404);
      expect((await collaborator(`/attempts/${review}`)).value).toMatchObject({
        studySetId: null,
        responses: {
          [cardId]: expect.objectContaining({ note: "Private co-owner note" }),
        },
      });
      expect(
        (
          await collaborator(`/attempts/${review}/retry`, "POST", {
            mode: "flagged",
          })
        ).status,
      ).toBe(422);
      const reinvite = (await invite(coOwner.email)).value.invitations[0].id;
      await collaborator(respond(reinvite), "POST", { accept: true });
      const active = (await collaborator(path + "/attempts", "POST", {})).value
        .id;
      expect((await a(path, "DELETE", { revision: 2 })).status).toBe(200);
      expect((await collaborator(path)).status).toBe(404);
      expect(
        (await collaborator(`/attempts/${active}`)).value.studySetId,
      ).toBeNull();
      await collaborator(`/sets/${copy.id}`, "DELETE", { revision: 2 });
    }, 90000);
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
