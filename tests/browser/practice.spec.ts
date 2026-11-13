import { chooseOption } from "./selector";
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
  const dialog = page.getByRole("dialog", { name: "Set up exam" });
  const simulation = dialog.getByRole("button", { name: "Exam simulation" });
  const quick = dialog.getByRole("button", { name: "Quick practice" });
  await expect(dialog.getByLabel("Number of questions")).toHaveValue("3");
  await expect(dialog.getByLabel("Item order")).toHaveText("Original order");
  const order = dialog.getByRole("combobox", { name: "Item order" });
  await order.press("s");
  await expect(order).toBeFocused();
  await expect(order).toHaveAttribute("aria-expanded", "true");
  await expect(order).toHaveText("Original order");
  await expect(dialog.getByRole("listbox")).toHaveCSS(
    "animation-name",
    "selector-enter",
  );
  await page.screenshot({
    path: "/tmp/examprep-selector-practice-desktop.png",
    animations: "disabled",
  });
  await order.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(order).toHaveAttribute("aria-expanded", "false");
  await order.press("End");
  await order.press("Enter");
  await expect(order).toHaveText("Shuffled order");
  await order.press("Home");
  await order.press("Tab");
  await expect(order).toHaveText("Shuffled order");
  await expect(order).toHaveAttribute("aria-expanded", "false");
  await chooseOption(order, "Original order");
  await expect(dialog.getByLabel("Timer in minutes")).toHaveValue("");
  await expect(simulation).toHaveAttribute("aria-pressed", "false");
  await simulation.click();
  await expect(simulation).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Timer in minutes")).toHaveValue("30");
  await quick.click();
  await expect(quick).toHaveAttribute("aria-pressed", "true");
  await expect(simulation).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByLabel("Item order")).toHaveText("Shuffled order");
  await dialog.getByLabel("Number of questions").fill("2");
  await dialog.getByLabel("Timer in minutes").fill("5");
  await expect(quick).toHaveAttribute("aria-pressed", "false");
  await dialog.getByRole("button", { name: "Start exam" }).click();
  await expect(
    page.getByRole("heading", { name: "Question 1 of 2" }),
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

test("tracks answered progress and flags across the desktop map and mobile picker", async ({
  page,
}) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  if (attempt.snapshot.kind !== "exam") throw new Error("Expected exam");
  attempt.snapshot = {
    ...attempt.snapshot,
    questions: [
      {
        id: "choice",
        type: "single_choice",
        prompt: `Evaluate ${"a very long prompt ".repeat(24)}\n\n$$\n${"x^2+".repeat(35)}1\n$$`,
        options: [
          { id: "a", text: "One" },
          { id: "b", text: "Two" },
        ],
        answer: "a",
      },
      ...attempt.snapshot.questions.slice(1),
    ],
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1200, height: 840 });
  await page.goto("/practice/original");
  const map = page.getByRole("complementary", { name: "Question navigation" });
  const progress = page.getByRole("progressbar", {
    name: "Questions answered",
  });
  const flag = page.getByRole("button", { name: "Flag for later" });
  const picker = page.getByRole("button", { name: /^Question \d of 3$/ });
  const footer = page.locator(".study-footer");
  await expect(map).toBeVisible();
  await expect(picker).toBeHidden();
  await expect(footer.getByRole("button", { name: "Next" })).toBeInViewport();
  await expect(progress).toHaveJSProperty("value", 0);
  await expect(
    map.getByRole("button", { name: "Question 1, Unanswered" }),
  ).toHaveAttribute("aria-current", "step");
  await page.getByRole("radio", { name: /One/ }).check();
  await expect(progress).toHaveJSProperty("value", 1);
  await page.getByRole("button", { name: "Clear answer" }).click();
  await expect(progress).toHaveJSProperty("value", 0);
  await chooseOption(map.getByLabel("Filter questions"), "Flagged");
  await expect(map.getByRole("status")).toHaveText(
    "No questions match this filter.",
  );
  await flag.click();
  await expect(
    map.getByRole("button", { name: "Question 1, Unanswered, flagged" }),
  ).toBeVisible();
  await chooseOption(map.getByLabel("Filter questions"), "All questions");
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "/tmp/examprep-exam-desktop.png" });
  await map
    .getByRole("button", { name: "Question 3, Unanswered" })
    .press("Enter");
  await expect(
    page.getByRole("heading", { name: "Question 3 of 3" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Review and submit" }),
  ).toHaveClass(/\bprimary\b/);
  await expect.poll(() => attempt.position).toBe(2);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Question 3 of 3" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1199, height: 840 });
  await expect(map).toBeHidden();
  await expect(picker).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(footer).toHaveCSS("position", "sticky");
  await page.getByLabel("Your answer", { exact: true }).focus();
  await expect(footer).toHaveCSS("position", "static");
  await picker.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Question navigation" });
  await chooseOption(dialog.getByLabel("Filter questions"), "Flagged");
  await page.screenshot({ path: "/tmp/examprep-exam-mobile-picker.png" });
  await dialog
    .getByRole("button", { name: "Question 1, Unanswered, flagged" })
    .press("Enter");
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Question 1 of 3" }),
  ).toBeFocused();
  await expect(flag).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".katex-display")).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 540 });
    await expect(footer).toHaveCSS("position", "static");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  }
});

test("keeps the exam open at timer expiry and makes unanswered questions reachable from confirmation", async ({
  page,
}) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  await page.clock.install({ time: new Date(attempt.startedAt) });
  attempt.settings = { count: 3, order: "original", timerMinutes: 2 };
  await page.goto("/practice/original");
  await expect(page.getByRole("timer")).toBeVisible();
  await page.clock.fastForward(61_000);
  await expect(page.getByText("One minute or less remaining.")).toBeAttached();
  await page.clock.fastForward(60_000);
  await expect(
    page.getByText("Time is up. Submit when you’re ready."),
  ).toBeVisible();
  expect(attempt.status).toBe("in_progress");
  await page.getByRole("button", { name: "Flag for later" }).click();
  await page.getByRole("button", { name: "Review and submit" }).click();
  const dialog = page.getByRole("dialog", { name: "Submit this exam?" });
  await expect(dialog).toContainText("0 answered, 3 unanswered, 1 flagged");
  await expect(dialog).toContainText("Unanswered questions earn zero points.");
  await expect(dialog).not.toContainText("assess your written answers");
  await dialog.getByText("Review unanswered questions").click();
  await dialog.getByRole("button", { name: "Question 2", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Question 2 of 3" }),
  ).toBeFocused();
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("Written after expiry");
  await expect(
    page.getByRole("progressbar", { name: "Questions answered" }),
  ).toHaveJSProperty("value", 1);
  expect(attempt.status).toBe("in_progress");
});

test("keeps the mobile picker open with a save error and retries the jump", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/practice/original");
  api.outage(true);
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("Keep this answer");
  await page.getByRole("button", { name: "Question 1 of 3" }).click();
  const dialog = page.getByRole("dialog", { name: "Question navigation" });
  const jump = dialog.getByRole("button", { name: "Question 2, Unanswered" });
  await jump.click();
  await expect(dialog.getByRole("alert")).toContainText("Simulated outage");
  api.outage(false);
  await jump.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Question 2 of 3" }),
  ).toBeFocused();
  expect(api.records.get("original")?.responses.one.text).toBe(
    "Keep this answer",
  );
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
  await page.getByRole("button", { name: "Flag for later" }).click();
  await page.getByText("Study notes and confidence", { exact: true }).click();
  await chooseOption(page.getByLabel("Confidence", { exact: true }), "Low");
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
    page.getByRole("heading", { name: "Question 1 of 1" }),
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
