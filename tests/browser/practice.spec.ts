import { expect, test, type Page } from "@playwright/test";
import type { Attempt } from "../../client/lib/api";
import {
  grade,
  practiceSnapshot,
  retrySnapshot,
  validateProgressChanges,
  type PracticeSettings,
  type RetryMode,
} from "../../shared/attempts";
import { type StudyContent } from "../../shared/content";

const content: StudyContent = {
  schemaVersion: 1,
  title: "Practice setup exercise",
  kind: "exam",
  questions: [
    { id: "one", type: "written", prompt: "First prompt", answer: "A" },
    { id: "two", type: "written", prompt: "Second prompt", answer: "B" },
    { id: "three", type: "written", prompt: "Third prompt", answer: "C" },
  ],
};

function createAttempt(snapshot: StudyContent, id: string): Attempt {
  return {
    id,
    snapshot,
    responses: {},
    result: null,
    status: "in_progress",
    position: 0,
    revision: 1,
    startedAt: new Date().toISOString(),
    studySetId: "set",
    sourceAttemptId: null,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(page: Page) {
  const records = new Map([["original", createAttempt(content, "original")]]);
  let unavailable = false;
  let starts: unknown;
  let interruptedSave:
    { markCommitted: () => void; wait: Promise<void> } | undefined;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    if (path === "/auth/get-session")
      return route.fulfill({
        json: { user: { id: "owner", email: "owner@example.test" } },
      });
    if (path === "/sets")
      return route.fulfill({
        json: {
          items: [
            { id: "set", title: content.title, kind: content.kind, count: 3 },
          ],
          hasMore: false,
          courses: [],
          page: 0,
        },
      });
    if (path === "/sets/set/attempts") {
      starts = route.request().postDataJSON();
      const { snapshot, settings, fullSet } = practiceSnapshot(
        content,
        starts as PracticeSettings,
        () => 0,
      );
      const attempt = {
        ...createAttempt(snapshot, "custom"),
        settings,
        fullSet,
      };
      records.set(attempt.id, attempt);
      return route.fulfill({ status: 201, json: attempt });
    }
    const match = path.match(
      /^\/attempts\/([^/]+)(?:\/(progress|submit|retry))?$/,
    );
    const attempt = match && records.get(match[1]);
    if (!match || !attempt)
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    if (!match[2]) return route.fulfill({ json: attempt });
    if (unavailable)
      return route.fulfill({
        status: 503,
        json: { error: "Simulated outage" },
      });
    const input = route.request().postDataJSON();
    if (match[2] === "retry") {
      const snapshot = retrySnapshot(
        attempt.snapshot,
        attempt.responses,
        input.mode as RetryMode,
      );
      if (!snapshot)
        return route.fulfill({
          status: 422,
          json: { error: "Nothing to retry" },
        });
      const retry = {
        ...createAttempt(snapshot, "retry"),
        sourceAttemptId: attempt.id,
      };
      records.set(retry.id, retry);
      return route.fulfill({ status: 201, json: retry });
    }
    if (input.revision !== attempt.revision)
      return route.fulfill({ status: 409, json: { error: "Newer save" } });
    if (match[2] === "progress") {
      attempt.responses = validateProgressChanges(
        attempt.snapshot,
        attempt.status,
        attempt.responses,
        input.changes,
        input.position,
      );
      attempt.position = input.position;
      if (attempt.status === "reviewing")
        Object.assign(attempt, grade(attempt.snapshot, attempt.responses));
    } else Object.assign(attempt, grade(attempt.snapshot, attempt.responses));
    attempt.revision++;
    if (interruptedSave && match[2] === "progress") {
      const pending = interruptedSave;
      interruptedSave = undefined;
      pending.markCommitted();
      await pending.wait;
      return route.fulfill({
        status: 503,
        json: { error: "Acknowledgement was lost" },
      });
    }
    const { snapshot, responses, ...metadata } = attempt;
    return route.fulfill({ json: metadata });
  });
  return {
    records,
    starts: () => starts,
    outage: (active: boolean) => {
      unavailable = active;
    },
    loseNextAcknowledgement: () => {
      const committed = deferred();
      const finish = deferred();
      interruptedSave = {
        markCommitted: committed.resolve,
        wait: finish.promise,
      };
      return { committed: committed.promise, finish: finish.resolve };
    },
  };
}

test("starts a configured snapshot and resumes with the same order and timer", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Set up practice" });
  await dialog.getByRole("button", { name: "Exam simulation" }).click();
  await expect(dialog.getByLabel("Timer in minutes")).toHaveValue("30");
  await dialog.getByRole("button", { name: "Quick practice" }).click();
  await expect(dialog.getByLabel("Item order")).toHaveValue("shuffled");
  await dialog.getByLabel("Number of questions").fill("2");
  await dialog.getByLabel("Timer in minutes").fill("5");
  await dialog.getByRole("button", { name: "Start practice" }).click();
  await expect(
    page.getByRole("button", { name: "Question 1 of 2" }),
  ).toBeVisible();
  await expect(page.getByText("Second prompt", { exact: true })).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  expect(api.starts()).toEqual({
    count: 2,
    order: "shuffled",
    timerMinutes: 5,
  });
  await page.reload();
  await expect(page.getByText("Second prompt", { exact: true })).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
});

test("restores a failed answer after a reload and asks before replacing a newer answer", async ({
  page,
}) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  await page.goto("/practice/original");
  const answer = page.getByLabel("Your answer", { exact: true });
  api.outage(true);
  await answer.fill("Local answer");
  await expect(
    page.getByText(/A recovery checkpoint is saved on this device/),
  ).toBeVisible();
  await page.reload();
  const recovery = page.getByRole("dialog", {
    name: "Restore practice progress?",
  });
  await expect(answer).toHaveValue("");
  api.outage(false);
  await recovery
    .getByRole("button", { name: "Restore progress", exact: true })
    .click();
  await expect(answer).toHaveValue("Local answer");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(attempt.responses.one.text).toBe("Local answer");

  api.outage(true);
  await answer.fill("Local follow-up");
  await expect(
    page.getByText(/A recovery checkpoint is saved on this device/),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download my unsaved answers" })
    .click();
  const recoveryFile = await (await downloadPromise).path();
  attempt.responses = { one: { text: "Other device" } };
  attempt.revision++;
  await page.reload();
  await expect(recovery).toContainText(
    "Another save changed 1 of the same items.",
  );
  await expect(answer).toHaveValue("Other device");
  await recovery.getByRole("button", { name: "Close dialog" }).click();
  await page.getByText("Practice recovery tools", { exact: true }).click();
  await page
    .getByLabel("Open a practice recovery copy")
    .setInputFiles(recoveryFile);
  await expect(recovery).toContainText(
    "Another save changed 1 of the same items.",
  );
  api.outage(false);
  await recovery
    .getByRole("button", { name: "Restore and replace newer changes" })
    .click();
  await expect(answer).toHaveValue("Local follow-up");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(attempt.responses.one.text).toBe("Local follow-up");
});

test("keeps completed scores fixed while saving private notes and flagging a retry", async ({
  page,
}) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  attempt.responses = { one: { text: "Submitted", selfAssessment: "correct" } };
  Object.assign(attempt, grade(attempt.snapshot, attempt.responses));
  const originalScore = attempt.result;
  await page.goto("/practice/original");
  await page.getByText("Study notes and flags", { exact: true }).click();
  await page.getByRole("button", { name: "Flag for later" }).click();
  await page.getByLabel("Confidence", { exact: true }).selectOption("low");
  await page
    .getByLabel("Private study note")
    .fill("Practice the derivation again.");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(attempt.result).toEqual(originalScore);
  expect(attempt.responses.one).toEqual({
    text: "Submitted",
    selfAssessment: "correct",
    flagged: true,
    confidence: "low",
    note: "Practice the derivation again.",
  });
  await page
    .getByRole("button", { name: "Practice flagged items (1)" })
    .click();
  await expect(
    page.getByRole("button", { name: "Question 1 of 1" }),
  ).toBeVisible();
  expect(api.records.get("retry")?.responses).toEqual({});
});

test("recovers a reversal when the previous answer committed but its acknowledgement was lost", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/practice/original");
  const answer = page.getByLabel("Your answer", { exact: true });
  await answer.fill("Original answer");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  const interrupted = api.loseNextAcknowledgement();
  await answer.fill("In-flight answer");
  await interrupted.committed;
  await answer.fill("Original answer");
  interrupted.finish();
  await expect(
    page.getByText(/A recovery checkpoint is saved on this device/),
  ).toBeVisible();
  await page.reload();
  await expect(answer).toHaveValue("In-flight answer");
  const recovery = page.getByRole("dialog", {
    name: "Restore practice progress?",
  });
  await recovery
    .getByRole("button", { name: "Restore and replace newer changes" })
    .click();
  await expect(answer).toHaveValue("Original answer");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(api.records.get("original")?.responses.one.text).toBe(
    "Original answer",
  );
});
