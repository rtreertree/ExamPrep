import {execFile} from "node:child_process";
import {promisify} from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "../generated/prisma/client";
import { connectDatabase } from "../server/db";
import { databasePasswords, PASSWORD_PATTERN } from "../server/passwords";
import { readTestTarget, verifyTestApp, verifyTestTarget } from "../scripts/test-target";
const enabled = process.env.RUN_DATABASE_TESTS === "1";
const base = process.env.TEST_BASE_URL ?? "";
const target = enabled ? readTestTarget() : undefined;
let db: ReturnType<typeof connectDatabase> | undefined;
const exam = JSON.parse(
  readFileSync("public/downloads/example-exam.examprep.json", "utf8"),
);
const deck = JSON.parse(
  readFileSync("public/downloads/example-flashcards.examprep.json", "utf8"),
);
const emails: string[] = [];
async function runCloneCommand(copyId: string, ...options: string[]) {
  const result = await promisify(execFile)(process.execPath, [
    "--import", "tsx", "scripts/convert-clones.ts", "--copy", copyId, ...options,
  ], { env: { ...process.env, DATABASE_URL_UNPOOLED: target!.direct } });
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}
function client() {
  let cookie = "";
  return async (path: string, method = "GET", body?: unknown, raw?: string) => {
    const options = {
      method,
      redirect: "error" as const,
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
    const value = response.status === 204 ? null : ((await response.json()) as any);
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
      await verifyTestTarget(target!);
      await verifyTestApp(base, target!.runtime);
      db = connectDatabase(target!.direct);
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
      if (!db) return;
      try {
        await db.user.deleteMany({ where: { email: { in: emails } } });
        expect(await db.user.count({ where: { email: { in: emails } } })).toBe(0);
      } finally {
        await db.$disconnect();
      }
    });
    it("creates one review set per save request and scopes retries to the account", async () => {
      const path = `/sets?requestId=${randomUUID()}`;
      const [first, retry] = await Promise.all([
        a(path, "POST", exam),
        a(path, "POST", exam),
      ]);
      expect([first.status, retry.status].sort()).toEqual([200, 201]);
      expect(first.value.id).toBe(retry.value.id);
      const anotherUser = await b(path, "POST", exam);
      expect(anotherUser.status).toBe(201);
      expect(anotherUser.value.id).not.toBe(first.value.id);
      await Promise.all([
        a(`/sets/${first.value.id}`, "DELETE", { revision: 1 }),
        b(`/sets/${anotherUser.value.id}`, "DELETE", { revision: 1 }),
      ]);
    });
    it("reuses exact documents across independent requests while keeping explicit copies and retries distinct", async () => {
      const content = { ...deck, title: "Concurrent " + randomUUID() };
      const path = () => `/sets?requestId=${randomUUID()}`;
      const save = path();
      const reordered = Object.fromEntries(Object.entries(content).reverse());
      const saves = await Promise.all([a(save, "POST", content), a(path(), "POST", reordered)]);
      expect(saves.map(({ status }) => status).sort()).toEqual([200, 201]);
      const original = saves[0].value.id;
      expect(saves[1].value.id).toBe(original);
      expect((await a(save, "POST", { ...content, title: "Changed" })).status).toBe(409);
      await a(`/sets/${original}/organization`, "PATCH", { archived: true, course: "Previously studied" });
      const archived = await a(path(), "POST", content);
      expect(archived.headers.get("X-Study-Set-Reused")).toBe("1");
      expect(archived.value).toMatchObject({ id: original, archived: true, course: "Previously studied" });

      const makeCopy = path() + "&copy=1";
      const copy = await a(makeCopy, "POST", content);
      expect(copy.status).toBe(201);
      expect(copy.value.id).not.toBe(original);
      expect((await a(makeCopy, "POST", reordered)).value.id).toBe(copy.value.id);
      expect((await a(path(), "POST", content)).value.id).toBe(copy.value.id);
      const changed = await a(path(), "POST", { ...content, cards: [...content.cards].reverse() });
      expect(changed.status).toBe(201);
      const other = await b(path(), "POST", content);
      expect(other.status).toBe(201);
      await a(`/sets/${copy.value.id}`, "DELETE", { revision: 1 });
      expect((await a(makeCopy, "POST", content)).status).toBe(404);
      expect((await a(path(), "POST", content)).value.id).toBe(original);
      await a(`/sets/${original}`, "DELETE", { revision: 1 });
      await a(`/sets/${changed.value.id}`, "DELETE", { revision: 1 });
      await b(`/sets/${other.value.id}`, "DELETE", { revision: 1 });
    });

    it("replays a keyed edit at its original revision and detects a changed edit request", async () => {
      const content = { ...exam, title: "Editable " + randomUUID() };
      const { value: first } = await a("/sets", "POST", content);
      const url = `/sets/${first.id}`;
      const edit = url + `?requestId=${randomUUID()}`;
      const updated = { ...content, title: "Saved " + randomUUID() };
      const payload = { revision: first.revision, content: updated };
      expect((await a(edit, "PUT", payload)).value).toMatchObject({ id: first.id, revision: 2, content: updated });
      expect((await a(edit, "PUT", payload)).value).toMatchObject({ id: first.id, revision: 2, content: updated });
      expect((await a(edit, "PUT", { ...payload, content })).status).toBe(409);
      await a(url, "PUT", { revision: 2, content });
      expect((await a(edit, "PUT", payload)).value).toMatchObject({ revision: 2, content: updated });
      expect((await a(url, "PUT", { revision: 2, content: updated })).status).toBe(409);
      await a(url, "DELETE", { revision: 3 });
      expect((await a(edit, "PUT", payload)).status).toBe(404);
    });

    it("maps intentional copies one to one across backup exports and remembers restore outcomes after edits", async () => {
      const content = { ...exam, title: "Backup matching " + randomUUID() };
      const original = await a("/sets", "POST", content);
      const copy = await a(`/sets?copy=1&requestId=${randomUUID()}`, "POST", content);
      for (const set of [original, copy]) {
        expect((await a(`/sets/${set.value.id}/attempts`, "POST", {})).status).toBe(201);
      }
      const exportPair = async () => {
        const { value } = await a("/backup?history=1");
        const ids = [original.value.id, copy.value.id];
        value.library.folders = [];
        value.library.sets = value.library.sets.filter(({ id }: { id: string }) => ids.includes(id))
          .map((set: object) => ({ ...set, folderId: null, course: "" }));
        value.history.attempts = value.history.attempts.filter(({ studySetId }: { studySetId: string }) => ids.includes(studySetId));
        value.history.reviews = [];
        delete value.history.viewerReviews;
        return value;
      };
      const first = await exportPair();
      const second = await exportPair();
      expect((await b("/backup/preview", "POST", first)).value).toMatchObject({ setCount: 2, reusedSetCount: 0 });
      expect((await b("/backup/restore", "POST", first)).value).toMatchObject({ setCount: 2, reusedSetCount: 0, attemptCount: 2 });
      expect((await b("/backup/preview", "POST", second)).value).toMatchObject({ setCount: 0, reusedSetCount: 2 });
      expect((await b("/backup/restore", "POST", second)).value).toMatchObject({ setCount: 0, reusedSetCount: 2, attemptCount: 2 });
      const restored = (await b("/backup?history=1")).value;
      const copies = restored.library.sets.filter((set: { content: { title: string } }) => set.content.title === content.title);
      expect(copies).toHaveLength(2);
      for (const set of copies) {
        expect(restored.history.attempts.filter((attempt: { studySetId: string }) => attempt.studySetId === set.id)).toHaveLength(2);
      }
      await b(`/sets/${copies[0].id}`, "PUT", { revision: 1, content: { ...content, title: "Edited " + randomUUID() } });
      expect((await b("/backup/restore", "POST", first)).value).toMatchObject({ setCount: 0, reusedSetCount: 2, attemptCount: 0 });
      expect((await b(`/sets/${copies[0].id}`)).value.revision).toBe(2);
      for (const set of copies)
        await b(`/sets/${set.id}`, "DELETE", { revision: set.id === copies[0].id ? 2 : 1 });
      for (const set of [original, copy])
        await a(`/sets/${set.value.id}`, "DELETE", { revision: 1 });
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
      expect((await a(grouped + "&folders=0")).value).not.toHaveProperty(
        "folders",
      );
      const context = (
        await a("/library/context?include=folders,invitations,suggestion")
      ).value;
      expect(context.folders).toContainEqual(
        expect.objectContaining({ name: "Study skills" }),
      );
      expect(context.invitations).toEqual([]);
      expect(context.suggestion).toMatchObject({
        type: "resume",
        id: initial.id,
      });
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
    async function newLearner() {
      const session = client(),
        email = `acceptance-${randomUUID()}@example.test`;
      emails.push(email);
      expect(
        (
          await session("/auth/sign-up/email", "POST", {
            email,
            password,
            name: "Learner",
          })
        ).status,
      ).toBe(200);
      return session;
    }
    it("saves a live viewer membership, isolates practice, and revokes each grant independently", async () => {
      const b = await newLearner();
      const { value: set } = await a("/sets?copy=1", "POST", deck);
      const path = "/sets/" + set.id,
        guest = client();
      const { value: settings } = await a(path + "/sharing/link", "PUT", {
        enabled: true,
      });
      const token = settings.link.split("#")[1];
      const preview = () => guest("/shares/preview", "POST", { token });
      expect((await preview()).value.content).toEqual(deck);
      expect((await guest("/shares/save", "POST", { token })).status).toBe(401);
      await db!.studySet.update({
        where: { id: set.id },
        data: { published: true },
      });
      const saves = await Promise.all([
        b("/shares/save", "POST", { token }),
        b("/discover/" + set.id + "/save", "POST", {}),
      ]);
      expect(saves.map((x) => x.value.id)).toEqual([set.id, set.id]);
      expect((await b(path)).value.ownershipRole).toBe("viewer");
      expect(
        (await b(path, "PUT", { revision: 1, content: deck })).status,
      ).toBe(404);
      expect((await b(path + "/duplicate", "POST", {})).status).toBe(404);
      expect((await b(path + "/sharing")).status).toBe(404);
      expect((await b(path, "DELETE", { revision: 1 })).status).toBe(404);
      const old = (await b(path + "/attempts", "POST", {})).value;
      expect((await a("/attempts/" + old.id)).status).toBe(404);
      const revised = { ...deck, title: "Updated deck" };
      expect(
        (await a(path, "PUT", { revision: 1, content: revised })).status,
      ).toBe(200);
      expect((await preview()).value.content).toEqual(revised);
      expect(
        (await b(path + "/attempts", "POST", {})).value.snapshot.title,
      ).toBe(revised.title);
      expect((await b("/attempts/" + old.id)).value.snapshot.title).toBe(
        deck.title,
      );
      expect((await b(path + "/review", "PATCH", { limit: 3 })).status).toBe(
        200,
      );
      expect((await a(path + "/review")).value.limit).toBe(20);
      expect((await b(path + "/review", "POST", {})).status).toBe(201);
      expect(
        (await b(path + "/organization", "PATCH", { pinned: true })).status,
      ).toBe(200);
      expect((await a(path)).value.pinned).toBe(false);
      await a(path + "/sharing/link", "PUT", { enabled: false });
      expect((await preview()).status).toBe(404);
      expect((await b(path)).status).toBe(200);
      await db!.studySet.update({
        where: { id: set.id },
        data: { published: false },
      });
      expect((await b(path)).status).toBe(404);
      expect((await b("/attempts/" + old.id)).value.studySetId).toBeNull();
      expect((await b(path + "/attempts", "POST", {})).status).toBe(404);
    });
    it("keeps viewer grants, placement, schedules and History when co-ownership is removed", async () => {
      const learner = await newLearner();
      const learnerId = (await learner("/auth/get-session")).value.user.id;
      const content = { ...deck, title: "Grant transitions " + randomUUID() };
      const { value: set } = await a("/sets", "POST", content);
      const path = `/sets/${set.id}`;
      await db!.studySet.update({ where: { id: set.id }, data: { published: true } });
      const { value: { link } } = await a(path + "/sharing/link", "PUT", { enabled: true });
      expect((await learner(`/discover/${set.id}/save`, "POST", {})).status).toBe(200);
      await learner(path + "/organization", "PATCH", { pinned: true, course: "Personal study" });
      await learner(path + "/review", "PATCH", { limit: 5 });
      const { cardFingerprint } = await import("../server/spacedReview");
      const started = new Date();
      const card = content.cards[0];
      await db!.cardReview.create({ data: {
        userId: learnerId, studySetId: set.id, cardId: card.id, streak: 1,
        fingerprint: await cardFingerprint(card), attemptStartedAt: started,
        dueAt: new Date(started.getTime() + 86_400_000),
      } });
      const { value: attempt } = await learner(path + "/attempts", "POST", {});
      const learnerEmail = (await learner("/auth/get-session")).value.user.email;
      const { value: { invitations: [invite] } } = await a(path + "/sharing/invitations", "POST", { email: learnerEmail });
      expect((await learner(`/ownership-invitations/${invite.id}/respond`, "POST", { accept: true })).status).toBe(200);
      expect((await learner(path)).value).toMatchObject({ ownershipRole: "co_owner", pinned: true, course: "Personal study", reviewLimit: 5 });
      expect((await learner("/shares/save", "POST", { token: link.split("#")[1] })).status).toBe(200);
      expect((await a(path + `/sharing/co-owners/${learnerId}`, "DELETE", {})).status).toBe(200);
      expect((await learner(path)).value).toMatchObject({ ownershipRole: "viewer", pinned: true, course: "Personal study", reviewLimit: 5 });
      await db!.studySet.update({ where: { id: set.id }, data: { published: false } });
      expect((await learner(path)).status).toBe(200);
      expect((await learner(`/attempts/${attempt.id}`)).value.studySetId).toBe(set.id);
      expect(await db!.cardReview.count({ where: { userId: learnerId, studySetId: set.id } })).toBe(1);
      expect((await a(path + "/sharing/link", "PUT", { enabled: false })).status).toBe(200);
      expect((await learner(path)).status).toBe(404);
      expect(await db!.cardReview.count({ where: { userId: learnerId, studySetId: set.id } })).toBe(0);
      expect((await learner(`/attempts/${attempt.id}`)).value).toMatchObject({ studySetId: null, snapshot: attempt.snapshot });
      await a(path, "DELETE", { revision: 1 });
    });

    it("round-trips private viewer review schedules without granting access to a deck", async () => {
      const viewer = await newLearner();
      const { value: set } = await a("/sets?copy=1", "POST", deck);
      const path = `/sets/${set.id}`;
      const { value: settings } = await a(path + "/sharing/link", "PUT", {
        enabled: true,
      });
      const token = settings.link.split("#")[1];
      const save = () => viewer("/shares/save", "POST", { token });
      expect((await save()).status).toBe(200);
      const started = await viewer(path + "/review", "POST", {});
      expect(started.status).toBe(201);
      const attempt = started.value;
      const cardId = deck.cards[0].id;
      const progress = await viewer(
        `/attempts/${attempt.id}/progress`,
        "PATCH",
        {
          revision: 1,
          position: 0,
          responses: { [cardId]: { revealed: true, rating: "known" } },
        },
      );
      expect(progress.status).toBe(200);
      expect(
        (
          await viewer(`/attempts/${attempt.id}/submit`, "POST", {
            revision: progress.value.revision,
          })
        ).status,
      ).toBe(200);
      const { cards } = (await viewer(path + "/review")).value;
      const dueAt = cards.find(
        ({ id }: { id: string }) => id === cardId,
      ).nextReviewAt;
      const { value: backup } = await viewer("/backup?history=1");
      expect(backup.library.sets).toEqual([]);
      expect(backup.history.attempts).toMatchObject([
        { id: attempt.id, studySetId: null },
      ]);
      expect(backup.history.viewerReviews).toMatchObject([
        { studySetId: set.id, cardId, streak: 1, dueAt: expect.any(String) },
      ]);
      expect(
        new Date(backup.history.viewerReviews[0].dueAt).toISOString(),
      ).toBe(dueAt);
      expect((await a("/backup?history=1")).value.history).not.toHaveProperty(
        "viewerReviews",
      );
      expect((await viewer("/backup")).value).not.toHaveProperty("history");
      expect((await viewer("/backup/preview", "POST", backup)).value).toMatchObject({
        reviewCount: 0, reviewSkips: { unchanged: 1 },
      });
      const viewerUser = (await viewer("/auth/get-session")).value.user;
      await db!.cardReview.deleteMany({ where: { studySetId: set.id, userId: viewerUser.id } });
      expect((await viewer("/backup/preview", "POST", backup)).value.reviewCount).toBe(1);

      expect((await viewer(path + "/membership", "DELETE", {})).status).toBe(
        204,
      );
      expect(
        (await viewer("/backup/restore", "POST", backup)).value,
      ).toMatchObject({
        setCount: 0,
        attemptCount: 1,
        reviewCount: 0,
        reviewSkips: { inaccessible: 1 },
      });
      expect((await viewer("/backup/preview", "POST", backup)).value).toMatchObject({
        reviewCount: 0, reviewSkips: { inaccessible: 1 },
      });
      expect((await viewer(path)).status).toBe(404);
      expect((await save()).status).toBe(200);
      expect(
        (await viewer("/backup/restore", "POST", backup)).value,
      ).toMatchObject({
        setCount: 0,
        attemptCount: 0,
        reviewCount: 1,
      });
      expect((await viewer(path + "/review")).value.cards).toContainEqual(
        expect.objectContaining({
          id: cardId,
          nextReviewAt: dueAt,
          due: false,
        }),
      );
      expect(
        (await viewer("/backup?history=1")).value.history.viewerReviews,
      ).toEqual(backup.history.viewerReviews);
      expect((await viewer("/backup/restore", "POST", backup)).value).toMatchObject({
        reviewCount: 0, reviewSkips: { unchanged: 1 },
      });
      const revised = {
        ...deck,
        cards: deck.cards.map((card: { id: string; front: string; back: string }) =>
          card.id === cardId ? { ...card, front: "Revised card" } : card),
      };
      expect((await a(path, "PUT", { revision: set.revision, content: revised })).status).toBe(200);
      for (const endpoint of ["/backup/preview", "/backup/restore"]) {
        expect((await viewer(endpoint, "POST", backup)).value).toMatchObject({
          reviewCount: 0, reviewSkips: { cardMismatch: 1 },
        });
      }
      const trimmed = { ...revised, cards: revised.cards.filter((card: { id: string }) => card.id !== cardId) };
      expect((await a(path, "PUT", { revision: set.revision + 1, content: trimmed })).status).toBe(200);
      expect((await viewer("/backup/preview", "POST", backup)).value).toMatchObject({
        reviewCount: 0, reviewSkips: { cardMismatch: 1 },
      });
      const badBackup = structuredClone(backup);
      badBackup.history.viewerReviews[0].attemptStartedAt = "2099-01-01T00:00:00.000Z";
      expect((await viewer("/backup/restore", "POST", badBackup)).status).toBe(422);
    });
    it.each(["discover", "link", "both"] as const)(
      "converts a historical clone with %s access and preserves its private study data",
      async (grant) => {
        const { value: source } = await a("/sets?copy=1", "POST", deck);
        const nonce = grant === "discover" ? null : randomUUID();
        if (nonce)
          await db!.studySetCopyLink.create({
            data: { studySetId: source.id, nonce },
          });
        const { value: copy } = await b("/sets?copy=1", "POST", deck);
        const user = (await b("/auth/get-session")).value.user;
        await db!.studySetCopyImport.create({
          data: {
            copyId: copy.id,
            userId: user.id,
            linkNonce: nonce ?? "discover:" + source.id,
            requestId: randomUUID(),
          },
        });
        const path = "/sets/" + copy.id;
        await b(path + "/organization", "PATCH", { pinned: true });
        const { value: attempt } = await b(path + "/attempts", "POST", {});
        const { cardFingerprint } = await import("../server/spacedReview");
        const start = new Date();
        await db!.cardReview.create({
          data: {
            studySetId: copy.id,
            userId: user.id,
            cardId: deck.cards[0].id,
            fingerprint: await cardFingerprint(deck.cards[0]),
            streak: 2,
            dueAt: start,
            attemptStartedAt: start,
          },
        });
        const run = (...options: string[]) => runCloneCommand(copy.id, ...options);
        if (!nonce)
          expect((await run("--apply")).counts).toEqual({
            "no-current-access": 1,
          });
        await db!.studySet.update({
          where: { id: source.id },
          data: { published: true },
        });
        if (grant === "both")
          expect(
            (await b(`/discover/${source.id}/save`, "POST", {})).status,
          ).toBe(200);
        expect((await run()).counts).toEqual({ eligible: 1 });
        expect((await run("--apply")).counts).toEqual({ converted: 1 });
        expect((await run("--apply")).counts).toEqual({
          "previously-converted": 1,
        });
        expect((await b(path)).value).toMatchObject({
          id: source.id,
          ownershipRole: "viewer",
          pinned: grant !== "both",
        });
        expect((await a(path)).status).toBe(404);
        expect((await b("/attempts/" + attempt.id)).value).toMatchObject({
          studySetId: source.id,
          studySetRevision: null,
          snapshot: attempt.snapshot,
        });
        expect(
          await db!.cardReview.count({
            where: { studySetId: source.id, userId: user.id },
          }),
        ).toBe(1);
        expect(
          (
            await db!.cloneConversion.findUniqueOrThrow({
              where: { copyId: copy.id },
            })
          ).recovery,
        ).toMatchObject({ set: { content: copy.content } });
        if (grant === "both") {
          expect(await run("--recover")).toMatchObject({ status: "recoverable", reviewCount: 1 });
          const recovered = await run("--recover", "--apply");
          expect(recovered).toMatchObject({ status: "recovered", reviewCount: 1 });
          expect(await run("--recover", "--apply")).toEqual({
            status: "previously-recovered", recoveredCopyId: recovered.recoveredCopyId,
          });
          expect((await b(`/sets/${recovered.recoveredCopyId}`)).value).toMatchObject({
            content: deck, ownershipRole: "primary", pinned: true,
          });
          expect((await b(path)).value.id).toBe(source.id);
          expect((await b(`/attempts/${attempt.id}`)).value.studySetId).toBe(source.id);
          expect(await db!.cardReview.count({ where: { studySetId: recovered.recoveredCopyId } })).toBe(1);
        }
        if (nonce) {
          await a(`/sets/${source.id}/sharing/link`, "PUT", { enabled: false });
          expect((await b(path)).status).toBe(grant === "both" ? 200 : 404);
        }
        await b("/sets/" + source.id + "/membership", "DELETE", {});
        expect((await b(path)).status).toBe(404);
      },
      45000,
    );
    it("retains changed or shared copies and refuses to remap a recorded missing original", async () => {
      const { value: source } = await a("/sets?copy=1", "POST", deck);
      const { value: replacement } = await a("/sets?copy=1", "POST", deck);
      const learner = (await b("/auth/get-session")).value.user;
      const recordedCopy = async (content: unknown) => {
        const { value: clone } = await b("/sets?copy=1", "POST", content);
        await db!.studySetCopyImport.create({ data: { copyId: clone.id, userId: learner.id,
          linkNonce: "discover:" + source.id, requestId: randomUUID() } });
        return clone;
      };
      await db!.studySet.update({ where: { id: source.id }, data: { published: true } });
      for (const content of [{ ...deck, title: "My own title" }, { ...deck,
        cards: [{ ...deck.cards[0], back: "My edit" }, ...deck.cards.slice(1)] }]) {
        const clone = await recordedCopy(content);
        expect((await runCloneCommand(clone.id, "--apply")).counts).toEqual({ "divergent-content": 1 });
        expect((await b(`/sets/${clone.id}`)).value.content).toEqual(content);
      }
      const shared = await recordedCopy(deck);
      expect((await b(`/sets/${shared.id}/sharing/link`, "PUT", { enabled: true })).status).toBe(200);
      expect((await runCloneCommand(shared.id, "--apply")).counts).toEqual({ "shared-or-nested": 1 });
      const missing = await recordedCopy(deck);
      expect((await a(`/sets/${source.id}`, "DELETE", { revision: source.revision })).status).toBe(200);
      expect((await runCloneCommand(missing.id, "--apply")).counts).toEqual({ "missing-origin": 1 });
      const dir = await mkdtemp(join(tmpdir(), "exam-prep-clone-matches-"));
      try {
        const path = join(dir, "matches.json");
        await writeFile(path, JSON.stringify([{ copyId: missing.id, sourceId: replacement.id, revision: missing.revision,
          evidence: "Fixture with matching replacement content" }]));
        expect((await runCloneCommand(missing.id, "--apply", "--matches", path)).counts).toEqual({ "conflicting-origin": 1 });
        expect((await b(`/sets/${missing.id}`)).status).toBe(200);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 45000);
    it("publishes live sets, grants and revokes library items, and enforces view-only links", async () => {
      const bob = (await b("/auth/get-session")).value.user;
      expect((await client()("/admin/users")).status).toBe(401);
      expect((await b("/admin/users")).status).toBe(403);
      expect((await b("/discover")).status).toBe(200);
      await db!.user.update({ where: { id: userId }, data: { role: "admin" } });
      const source = (await a("/sets", "POST", exam)).value;
      const base = "/admin/sets/" + source.id,
        listing = "/discover/" + source.id;
      const access = (input: unknown) => a(base + "/access", "POST", input);
      const recipient = "/admin/users/" + bob.id;
      try {
        const q = encodeURIComponent(bob.email);
        expect((await a("/admin/users?q=" + q)).value.items).toMatchObject([
          { id: bob.id },
        ]);
        expect((await b(listing)).status).toBe(404);
        expect(
          (
            await b(base + "/access", "POST", {
              action: "publish",
              enabled: true,
            })
          ).status,
        ).toBe(403);
        expect(
          (await access({ action: "publish", enabled: true })).status,
        ).toBe(200);
        expect(
          (
            await a("/admin/users/" + userId, "PATCH", {
              name: "  Owner ~7e;  ",
            })
          ).value.name,
        ).toBe("Owner ~7e;");
        expect((await b(listing)).value).toEqual({
          ownerName: "Owner ~7e;",
          content: exam,
        });
        await access({ action: "link", enabled: true });
        const { link } = (await a(base + "/access")).value;
        const token = link.split("#")[1];
        const revised = { ...exam, title: "Updated discovery title" };
        await a("/sets/" + source.id, "PUT", { revision: 1, content: revised });
        const view = () => b("/shares/preview", "POST", { token });
        expect((await view()).value).toEqual({
          ownerName: "Owner ~7e;",
          content: revised,
        });
        expect(
          (
            await b("/shares/import", "POST", {
              token,
              requestId: randomUUID(),
            })
          ).status,
        ).toBe(404);
        const requestId = randomUUID();
        const copies = await Promise.all(
          [1, 2].map(() => b(listing + "/clone", "POST", { requestId })),
        );
        expect(copies.map((x) => x.status).sort()).toEqual([200, 201]);
        const copy = copies[0].value.id;
        expect(copies[1].value.id).toBe(copy);
        expect((await b("/sets/" + copy)).value).toMatchObject({
          content: revised,
          ownerName: bob.name,
          revision: 1,
          ownershipRole: "primary",
        });
        await access({ action: "invite", email: bob.email });
        await access({ action: "grant", userId: bob.id });
        expect((await a(base + "/access")).value).toMatchObject({
          coOwners: 1,
          invitations: 0,
        });
        expect(
          (await a(base + "/recipients?q=" + q)).value.items,
        ).toMatchObject([{ id: bob.id, invited: false }]);
        expect((await b("/sets/" + source.id)).value).toMatchObject({
          ownershipRole: "co_owner",
          ownerName: "Owner ~7e;",
        });
        await b("/sets/" + source.id, "PUT", { revision: 2, content: exam });
        expect((await b(listing)).value.content).toEqual(exam);
        expect((await b("/sets/" + copy)).value.content).toEqual(revised);
        const attempt = (
          await b("/sets/" + source.id + "/attempts", "POST", {})
        ).value;
        await access({ action: "revoke", userId: bob.id });
        expect((await b("/sets/" + source.id)).status).toBe(404);
        const adminCopy = (
          await a(recipient + "/copies", "POST", {
            setId: source.id,
            requestId: randomUUID(),
          })
        ).value.id;
        expect((await b("/sets/" + adminCopy)).value).toMatchObject({
          ownerName: bob.name,
          content: exam,
        });
        expect(
          (await a(recipient + "/library?q=" + encodeURIComponent(exam.title)))
            .value.items,
        ).toContainEqual(
          expect.objectContaining({ id: adminCopy, ownershipRole: "primary" }),
        );
        const stale = (await a(base + "/access")).value;
        await access({ action: "publish", enabled: false });
        expect((await b(listing)).status).toBe(404);
        expect(
          (await b(listing + "/clone", "POST", { requestId: randomUUID() }))
            .status,
        ).toBe(404);
        expect((await view()).status).toBe(200);
        await access({ action: "link", enabled: false });
        expect((await view()).status).toBe(404);
        expect((await a(base, "DELETE", stale)).status).toBe(409);
        expect(
          (await a(base, "DELETE", (await a(base + "/access")).value)).status,
        ).toBe(200);
        expect((await b("/sets/" + copy)).status).toBe(200);
        expect(
          (await b("/attempts/" + attempt.id)).value.studySetId,
        ).toBeNull();
        await db!.attempt.delete({ where: { id: attempt.id } });
        await b("/sets/" + copy, "DELETE", { revision: 1 });
        await b("/sets/" + adminCopy, "DELETE", { revision: 1 });
      } finally {
        await db!.user.update({
          where: { id: userId },
          data: { role: "user", name: "Test" },
        });
      }
    }, 60000);

    it("pages directories of duplicate names and titles with stable cursors and filters", async () => {
      const group = "Page %_ " + randomUUID(),
        ids = Array.from({ length: 61 }, () => randomUUID());
      const setIds = ids.map(() => randomUUID());
      await db!.user.update({ where: { id: userId }, data: { role: "admin" } });
      try {
        await db!.user.createMany({
          data: ids.map((id) => ({
            id,
            name: group,
            email: id + "@example.test",
          })),
        });
        await db!.studySet.createMany({
          data: setIds.map((id) => ({
            id,
            userId,
            title: group,
            kind: "flashcards",
            published: true,
            content: { ...deck, title: group },
          })),
        });
        await db!.libraryEntry.createMany({
          data: ids.map((id) => ({ userId: id, studySetId: setIds[0], coOwner: true })),
        });
        const q = "q=" + encodeURIComponent(group);
        const paths = [
          ["/admin/users?role=user&status=active&" + q, ids],
          ["/admin/sets/" + setIds[0] + "/recipients?" + q, ids],
          ["/admin/sets?kind=flashcards&sharing=published&" + q, setIds],
          ["/admin/users/" + userId + "/library?" + q, setIds],
          ["/discover?" + q, setIds],
        ] as const;
        for (const [path, expected] of paths) {
          const first = (await a(path)).value;
          const second = (await a(path + "&after=" + first.next)).value;
          const last = (await a(path + "&after=" + second.next)).value;
          expect([
            first.items.length,
            second.items.length,
            last.items.length,
            last.next,
          ]).toEqual([30, 30, 1, null]);
          expect(
            [...first.items, ...second.items, ...last.items].map(
              (row) => row.id,
            ),
          ).toEqual([...expected].sort());
          expect(first.items[0]).not.toHaveProperty("content");
        }
        expect((await b("/discover?kind=exam&" + q)).value.items).toEqual([]);
      } finally {
        await db!.studySet.deleteMany({ where: { id: { in: setIds } } });
        await db!.user.deleteMany({ where: { id: { in: ids } } });
        await db!.user.update({
          where: { id: userId },
          data: { role: "user" },
        });
      }
    }, 60000);

    it("revokes sessions on email change and suspension and protects the final active admin", async () => {
      const target = client(),
        email = "managed-" + randomUUID() + "@example.test",
        changed = "edited-" + randomUUID() + "@example.test";
      emails.push(email, changed);
      const created = await target("/auth/sign-up/email", "POST", {
        name: "   Test  ",
        email,
        password,
      });
      expect(created.value.user.name).toBe("Test");
      const blank = await client()("/auth/sign-up/email", "POST", {
        email: "blank-" + randomUUID() + "@example.test",
        password,
        name: "   ",
      });
      expect(blank.status).toBeGreaterThanOrEqual(400);
      expect(blank.status).toBeLessThan(500);
      const id = created.value.user.id,
        path = "/admin/users/" + id;
      await db!.user.update({ where: { id: userId }, data: { role: "admin" } });
      try {
        await db!.user.update({ where: { id }, data: { emailVerified: true } });
        expect((await a(path, "PATCH", { email: changed })).status).toBe(200);
        expect((await target("/discover")).status).toBe(401);
        expect(
          (
            await target("/auth/sign-in/email", "POST", {
              email: changed,
              password,
            })
          ).value.user.emailVerified,
        ).toBe(false);
        await a(path, "PATCH", { suspended: true });
        expect((await target("/discover")).status).toBe(401);
        expect(
          (
            await target("/auth/sign-in/email", "POST", {
              email: changed,
              password,
            })
          ).status,
        ).toBe(403);
        await a(path, "PATCH", { suspended: false, role: "admin" });
        expect(
          (
            await target("/auth/sign-in/email", "POST", {
              email: changed,
              password,
            })
          ).status,
        ).toBe(200);
        if (
          (await db!.user.count({
            where: { role: "admin", suspended: false },
          })) === 2
        ) {
          const results = await Promise.all([
            a("/admin/users/" + userId, "PATCH", { role: "user" }),
            target(path, "PATCH", { suspended: true }),
          ]);
          expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
        }
      } finally {
        await db!.user.update({
          where: { id: userId },
          data: { role: "user" },
        });
        await db!.user.delete({ where: { id } });
      }
    }, 90000);

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
    it("merges batched maximum-length answers, upgrades legacy progress and preserves concurrent edits", async () => {
      const snapshot = {
        schemaVersion: 1,
        kind: "exam",
        title: "Delta checks",
        questions: ["__proto__", "second", "third"].map((id) => ({
          id,
          type: "written",
          prompt: "Prompt",
          answer: "Reference",
        })),
      };
      const legacy = await db!.attempt.create({ data: { userId, snapshot } });
      const path = `/attempts/${legacy.id}`;
      const answer = "🦊".repeat(20_000);
      const first = await a(path + "/progress", "PATCH", {
        revision: 1,
        position: 1,
        changes: {
          ["__proto__"]: { text: answer },
          second: { text: "old" },
          third: { text: "keep" },
        },
      });
      expect(first.status).toBe(200);
      expect(
        (
          await db!.attempt.findUniqueOrThrow({
            where: { id: legacy.id },
            select: { snapshotVersion: true },
          })
        ).snapshotVersion,
      ).toBe(1);
      const changes = {
        ["__proto__"]: { text: answer, flagged: true },
        second: null,
      };
      const competing = await Promise.all(
        [0, 1].map((position) =>
          a(path + "/progress", "PATCH", { revision: 2, position, changes }),
        ),
      );
      expect(competing.map((row) => row.status).sort()).toEqual([200, 409]);
      expect(
        (
          await a(path + "/progress", "PATCH", {
            revision: 3,
            position: 2,
            changes: {},
          })
        ).status,
      ).toBe(200);
      expect((await a(path)).value.responses).toEqual({
        ["__proto__"]: { text: answer, flagged: true },
        third: { text: "keep" },
      });
    }, 60000);

    it("persists flashcard reveal/rating, validates early completion, and selects exactly Review again", async () => {
      const set = (await a("/sets?copy=1", "POST", deck)).value;
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
        expect(
          (await a(groupPath + "&sort=title&order=desc")).value.items[0].title,
        ).toBe(`${title} 9`);
        expect((await a(attemptPath + "&order=asc")).value.items[0].id).toBe(
          groups[0].id,
        );
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
    it("reorders folders and sets across pages and restores their order from backup", async () => {
      const folderName = `Reorder ${randomUUID()}`;
      const created = await a("/folders", "POST", { name: folderName });
      expect(created.status).toBe(201);
      const folder = created.value;
      const empty = (
        await a("/folders", "POST", { name: folderName + " empty" })
      ).value;
      const foreign = (await b("/folders", "POST", { name: folderName })).value;
      expect((await b(`/folders/${folder.id}`)).status).toBe(404);
      expect(
        (await a(`/folders/${empty.id}`, "PATCH", { name: folderName })).status,
      ).toBe(409);
      const sets = Array.from({ length: 32 }, (_, index) => {
        const content = {
          ...deck,
          title: `Ordered set ${String(index + 1).padStart(2, "0")}`,
        };
        return {
          id: randomUUID(),
          userId,
          content,
          title: content.title,
          kind: deck.kind,
        };
      });
      await db!.$transaction(async (tx) => {
        await tx.studySet.createMany({ data: sets });
        await tx.libraryEntry.updateMany({
          where: { userId, studySetId: { in: sets.map(({ id }) => id) } },
          data: { folderId: folder.id },
        });
      });
      try {
        const found = (
          await a(
            `/folders?search=${encodeURIComponent(folderName.toLowerCase())}`,
          )
        ).value;
        expect(found.items).toEqual([
          { ...folder, count: 32 },
          { ...empty, count: 0 },
        ]);
        const firstPage = (await a(`/sets?folderId=${folder.id}&sort=manual`))
          .value;
        const secondPage = (
          await a(`/sets?folderId=${folder.id}&sort=manual&page=1`)
        ).value;
        expect(firstPage.manual).toEqual(secondPage.manual);
        expect(firstPage.manual.count).toBe(32);
        const moving = firstPage.items[0].id;
        const move = {
          kind: "set",
          id: moving,
          folderId: folder.id,
          archived: false,
          position: 31,
          version: firstPage.manual.version,
        };
        expect((await a("/library/order", "PATCH", move)).value).toEqual({
          position: 31,
        });
        expect((await a("/library/order", "PATCH", move)).status).toBe(409);
        expect(
          (await a(`/sets?folderId=${folder.id}&sort=manual&page=1`)).value
            .items[0].id,
        ).toBe(moving);
        expect(
          (await a(`/sets?folderId=${folder.id}&sort=title&order=desc`)).value
            .items[0].title,
        ).toBe("Ordered set 32");
        expect(
          (
            await a(`/sets/${moving}/organization`, "PATCH", {
              folderId: foreign.id,
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await a("/sets/organization", "PATCH", {
              ids: [moving],
              folderId: empty.id,
            })
          ).value,
        ).toEqual({ updated: 1 });
        expect((await a(`/sets?folderId=${empty.id}`)).value.items[0].id).toBe(
          moving,
        );
        expect(
          (
            await a("/sets/organization", "PATCH", {
              ids: [moving],
              folderId: folder.id,
            })
          ).value,
        ).toEqual({ updated: 1 });
        expect(
          (await a(`/sets?folderId=${folder.id}&sort=manual&page=1`)).value
            .items[1].id,
        ).toBe(moving);

        const folderOrder = (await a("/folders?sort=manual")).value;
        expect(
          (
            await a("/library/order", "PATCH", {
              kind: "folder",
              id: empty.id,
              position: 1,
              version: folderOrder.manual.version,
            })
          ).status,
        ).toBe(200);
        const backup = (await a("/backup")).value;
        const savedFolders = backup.library.folders.filter(
          ({ id }: { id: string }) => id === folder.id || id === empty.id,
        );
        const savedSets = backup.library.sets.filter(
          ({ folderId }: { folderId: string }) => folderId === folder.id,
        );
        expect(savedFolders.map(({ id }: { id: string }) => id)).toEqual([
          empty.id,
          folder.id,
        ]);
        expect(savedSets.at(-1).id).toBe(moving);
        const restore = {
          library: {
            ...backup.library,
            folders: savedFolders,
            sets: savedSets,
          },
        };
        expect((await b("/backup/restore", "POST", restore)).value).toMatchObject({
          setCount: 32, folderCount: 1,
        });
        expect(
          (await b("/backup/restore", "POST", restore)).value.setCount,
        ).toBe(0);
        const restored = (
          await b(`/folders?search=${encodeURIComponent(folderName)}`)
        ).value.items;
        expect(restored).toEqual([
          { ...foreign, count: 32 },
          expect.objectContaining({ name: empty.name, count: 0 }),
        ]);
        expect(
          (await b(`/sets?folderId=${foreign.id}&sort=manual&page=1`)).value
            .items[1].title,
        ).toBe(savedSets.at(-1).content.title);
        const legacyCourse = `Legacy ${randomUUID()}`;
        const { folderId: _folder, ...oldSet } = savedSets[0];
        const legacy = {
          schemaVersion: 1,
          kind: "exam-prep-library",
          backupId: randomUUID(),
          sets: [{
            ...oldSet,
            content: { ...oldSet.content, title: "Legacy backup " + randomUUID() },
            course: legacyCourse,
          }],
        };
        expect(
          (await b("/backup/restore", "POST", { library: legacy })).value
            .setCount,
        ).toBe(1);
        expect(
          (await b(`/folders?search=${encodeURIComponent(legacyCourse)}`)).value
            .items,
        ).toMatchObject([{ name: legacyCourse, count: 1 }]);

        expect(
          (await a(`/sets/${moving}/organization`, "PATCH", { archived: true }))
            .status,
        ).toBe(200);
        expect((await a(`/folders/${folder.id}`, "DELETE", {})).status).toBe(
          204,
        );
        expect((await a(`/sets/${moving}`)).value).toMatchObject({
          folderId: null,
          archived: true,
        });
      } finally {
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
      expect(
        starts.find((row) => row.status === 201)?.value.attempt,
      ).toMatchObject({
        id: starts[0].value.id,
        reviewMode: true,
        snapshot: { cards: [content.cards[0]] },
      });
      expect(starts.find((row) => row.status === 200)?.value).toEqual({
        id: starts[0].value.id,
      });
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
      expect(preview.value).toEqual({content:revised,ownerName:"Test"});
      expect((await stranger("/shares/import","POST",{token,requestId:randomUUID()})).status).toBe(404);
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
        guestAccess: false,
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
