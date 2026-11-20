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
import { itemsOf } from "../../shared/contentItems";

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

async function fixture(page: Page, doc: StudyContent = content) {
  const records = new Map([["original", createAttempt(doc, "original")]]);
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
    if (path === "/library/context")
      return route.fulfill({
        json: { folders: [], invitations: [], suggestion: null },
      });
    if (path === "/sets")
      return route.fulfill({
        json: {
          items: [
            {
              id: "set",
              title: doc.title,
              kind: doc.kind,
              count: itemsOf(doc).length,
            },
          ],
          hasMore: false,
          courses: [],
          page: 0,
        },
      });
    if (path === "/sets/set/attempts") {
      starts = route.request().postDataJSON();
      const { snapshot, settings, fullSet } = practiceSnapshot(
        doc,
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
  await page.goto("/library");
  const practice = page.getByRole("button", { name: "Practice", exact: true });
  await practice.click();
  const dialog = page.getByRole("dialog", { name: "Set up exam" });
  const full = dialog.getByRole("radio", { name: "Full set" });
  const simulation = dialog.getByRole("radio", { name: "Exam simulation" });
  const quick = dialog.getByRole("radio", { name: "Quick practice" });
  const customize = dialog.getByRole("radio", { name: "Customize" });
  await expect(full).toBeChecked();
  await expect(dialog.getByLabel("Number of questions")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(practice).toBeFocused();
  expect(api.starts()).toBeUndefined();
  await practice.click();
  await simulation.check();
  await expect(simulation).toBeChecked();
  await customize.check();
  await expect(dialog.getByLabel("Number of questions")).toHaveValue("3");
  await expect(dialog.getByLabel("Item order")).toHaveText("Original order");
  await expect(dialog.getByLabel("Timer in minutes")).toHaveValue("30");
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
  await quick.check();
  await expect(quick).toBeChecked();
  await customize.check();
  await expect(dialog.getByLabel("Item order")).toHaveText("Shuffled order");
  await expect(dialog.getByLabel("Timer in minutes")).toHaveValue("");
  await dialog.getByLabel("Number of questions").fill("2");
  await dialog.getByLabel("Timer in minutes").fill("5");
  await expect(customize).toBeChecked();
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

test("resumes the account-wide suggestion, handles failures, and keeps the action in view", async ({
  page,
}) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  attempt.position = 1;
  attempt.studySetId = "biology";
  attempt.snapshot = { ...attempt.snapshot, title: "Biology midterm" };
  let status = 200;
  let assessing = false;
  await page.route("**/api/library/context?**", (route) =>
    route.fulfill({
      status,
      json:
        status === 200
          ? {
              folders: [],
              invitations: [],
              suggestion: {
                type: "resume",
                id: attempt.id,
                title: attempt.snapshot.title,
                kind: "exam",
                status: assessing ? "reviewing" : "in_progress",
                position: attempt.position,
                total: 3,
                pendingCount: assessing ? 1 : null,
                reviewMode: false,
              },
            }
          : { error: "Suggestion unavailable" },
    }),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/library?page=1");
  const suggestion = page.getByRole("region", { name: "Next study action" });
  const resume = suggestion.getByRole("link", { name: "Resume", exact: true });
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
    [320, 740],
  ]) {
    if (width === 320) {
      attempt.snapshot = {
        ...attempt.snapshot,
        title: "Extended practice and review ".repeat(7).trim(),
      };
      await page.reload();
    }
    await page.setViewportSize({ width, height });
    await expect(resume).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    if (width !== 320) {
      await page.screenshot({
        path: `/tmp/examprep-study-library-${width}.png`,
        animations: "disabled",
      });
    }
  }
  await page.keyboard.press("Tab");
  for (
    let index = 0;
    index < 12 &&
    !(await resume.evaluate((link) => link === document.activeElement));
    index++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(resume).toBeFocused();
  await expect(resume).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Question 2 of 3" }),
  ).toBeVisible();
  expect(api.starts()).toBeUndefined();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/page=1/);
  assessing = true;
  await page.reload();
  await expect(
    suggestion.getByRole("link", { name: "Finish assessment" }),
  ).toBeVisible();
  await expect(suggestion).toContainText("1 written answer to assess");
  await page
    .getByRole("searchbox", { name: "Search library" })
    .fill("practice");
  await expect(suggestion).toHaveCount(0);
  await expect(page).toHaveURL(/search=practice/);
  await page.getByRole("button", { name: "Remove search filter" }).click();
  await expect(suggestion).toBeVisible();
  status = 503;
  const failure = page.waitForResponse("**/api/library/context?**");
  await page.reload();
  expect((await failure).status()).toBe(503);
  await expect(suggestion).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Practice", exact: true }),
  ).toBeEnabled();
});

const deck: StudyContent = {
  schemaVersion: 1,
  title: "Practice cards",
  kind: "flashcards",
  cards: Array.from({ length: 12 }, (_, index) => ({
    id: String(index),
    front: `Card ${index + 1}`,
    back: "Answer",
  })),
};

for (const [doc, preset, settings] of [
  [content, "Full set", { count: 3, order: "original", timerMinutes: null }],
  [
    content,
    "Quick practice",
    { count: 3, order: "shuffled", timerMinutes: null },
  ],
  [
    content,
    "Exam simulation",
    { count: 3, order: "original", timerMinutes: 30 },
  ],
  [deck, "Full set", { count: 12, order: "original", timerMinutes: null }],
  [
    deck,
    "Quick practice",
    { count: 10, order: "shuffled", timerMinutes: null },
  ],
  [deck, "Customize", { count: 5, order: "shuffled", timerMinutes: 6 }],
] as const) {
  test(`starts ${doc.kind} with ${preset}`, async ({ page }) => {
    const api = await fixture(page, doc);
    const useSuggestion = doc.kind === "exam" && preset === "Full set";
    if (useSuggestion) {
      await page.route("**/api/library/context?**", (route) =>
        route.fulfill({
          json: {
            folders: [],
            invitations: [],
            suggestion: {
              type: "practice",
              set: {
                id: "set",
                title: doc.title,
                kind: doc.kind,
                count: itemsOf(doc).length,
              },
            },
          },
        }),
      );
    }
    const gets: string[] = [];
    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        request.url().includes("/api/") &&
        !request.url().includes("/auth/")
      )
        gets.push(new URL(request.url()).pathname);
      if (
        request.method() === "POST" &&
        request.url().endsWith("/sets/set/attempts")
      )
        requests.push(request.url());
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/library");
    await page
      .getByRole("button", {
        name: useSuggestion ? "Set up practice" : "Practice",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog");
    if (doc.kind === "flashcards") {
      await expect(
        dialog.getByRole("radio", { name: "Exam simulation" }),
      ).toHaveCount(0);
    }
    await dialog.getByRole("radio", { name: preset }).check();
    if (preset === "Customize") {
      await dialog.getByLabel("Number of cards").fill(String(settings.count));
      await chooseOption(dialog.getByLabel("Item order"), "Shuffled order");
      await dialog
        .getByLabel("Timer in minutes")
        .fill(String(settings.timerMinutes));
    }
    expect(requests).toHaveLength(0);
    await dialog
      .getByRole("button", {
        name: doc.kind === "exam" ? "Start exam" : "Start practice",
      })
      .click();
    await expect(page).toHaveURL(/\/practice\/custom$/);
    expect(requests).toHaveLength(1);
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    expect(gets.sort()).toEqual(["/api/library/context", "/api/sets"]);
    await page.reload();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    expect(gets.at(-1)).toBe("/api/attempts/custom");
    expect(api.starts()).toEqual(settings);
  });
}

test("syncs within two seconds of the first edit during continuous typing", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/practice/original");
  const answer = page.getByLabel("Your answer", { exact: true });
  await expect(answer).toBeVisible();
  const start = new Date("2026-11-01T00:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/progress"))
      writes.push(request.postDataJSON());
  });
  await answer.fill("First");
  await page.clock.runFor(1500);
  await answer.fill("Still typing");
  expect(writes).toHaveLength(0);
  await page.clock.runFor(500);
  await expect.poll(() => writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    changes: { one: { text: "Still typing" } },
  });
});

test("saves a burst of edits and a question jump in one request", async ({
  page,
}) => {
  const api = await fixture(page);
  const writes: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/progress"))
      writes.push(request.postDataJSON());
  });
  await page.goto("/practice/original");
  await page.getByLabel("Your answer", { exact: true }).fill("First draft");
  await page.getByRole("button", { name: "Flag for later" }).click();
  await page.getByLabel("Your answer", { exact: true }).fill("Final answer");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Question 2 of 3" }),
  ).toBeVisible();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([
    {
      revision: 1,
      position: 1,
      changes: { one: { text: "Final answer", flagged: true } },
    },
  ]);
  expect(api.records.get("original")?.position).toBe(1);
});

test("leads a perfect result back to the Library", async ({ page }) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  attempt.responses = Object.fromEntries(
    content.questions.map(({ id }) => [
      id,
      { text: "My answer", selfAssessment: "correct" },
    ]),
  );
  Object.assign(attempt, grade(content, attempt.responses));
  await page.goto("/practice/original");
  const primary = page.locator(".results-intro .button.primary");
  await expect(primary).toHaveText("Return to library");
  await primary.click();
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
});

test("saves a custom review set from a historical exam and can retry a lost acknowledgement", async ({
  page,
}) => {
  const api = await fixture(page);
  const attempt = api.records.get("original")!;
  attempt.studySetId = null;
  attempt.responses = {
    one: { text: "Private answer", selfAssessment: "correct", flagged: true },
    two: {
      text: "Another answer",
      selfAssessment: "incorrect",
      note: "Private note",
    },
  };
  Object.assign(attempt, grade(content, attempt.responses));
  const requests: string[] = [];
  let saved: StudyContent | undefined;
  await page.route("**/api/sets/copy", (route) =>
    route.fulfill({ json: { id: "copy", revision: 1, content: saved } }),
  );
  await page.route("**/api/sets?requestId=*", (route) => {
    requests.push(route.request().url());
    saved = route.request().postDataJSON();
    return requests.length === 1
      ? route.fulfill({
          status: 503,
          json: { error: "Could not confirm save" },
        })
      : route.fulfill({ json: { id: "copy", title: saved!.title } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/practice/original");
  await page.getByRole("button", { name: "Create review set" }).click();
  const dialog = page.getByRole("dialog");
  const group = dialog.getByLabel("Selection preset");
  await expect(group).toHaveText("Missed questions (2)");
  await chooseOption(group, "Clear selection");
  const save = dialog.getByRole("button", { name: "Save to library" });
  await expect(save).toBeDisabled();
  await chooseOption(group, "Flagged (1)");
  await dialog.getByRole("checkbox", { name: /Question 2/ }).check();
  await expect(group).toHaveText("Custom selection");
  await dialog.getByLabel("Set title").fill("Midterm review");
  await page.screenshot({
    path: "/tmp/examprep-review-set-mobile.png",
    animations: "disabled",
  });
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Could not confirm save",
  );
  const second = dialog.getByRole("checkbox", { name: /Question 2/ });
  await second.uncheck();
  await second.check();
  await save.click();
  await expect(dialog.getByRole("status")).toContainText(
    "Midterm review is in your library",
  );
  expect(requests[1]).toBe(requests[0]);
  expect(saved).toEqual({
    ...content,
    title: "Midterm review",
    questions: content.questions.slice(0, 2),
  });
  await dialog.getByRole("link", { name: "Open set" }).click();
  await expect(
    page.getByRole("heading", { name: "Midterm review", level: 1 }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Preview" }).click();
  await page.getByRole("link", { name: "Print worksheet" }).click();
  await expect(
    page
      .getByRole("list", { name: "Worksheet prompts" })
      .locator(":scope > li"),
  ).toHaveCount(2);
  await page.getByRole("link", { name: "Editor", exact: true }).click();
  await expect(page).toHaveURL(/\/sets\/copy\/edit$/);
});

test("distinguishes review-again and unreviewed cards when creating a review set", async ({
  page,
}) => {
  const api = await fixture(page, deck);
  const attempt = api.records.get("original")!;
  attempt.responses = {
    "0": { revealed: true, rating: "known" },
    "1": { revealed: true, rating: "review_again" },
  };
  Object.assign(attempt, grade(deck, attempt.responses));
  await page.goto("/practice/original");
  await page.getByRole("button", { name: "Create review set" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Selection preset")).toHaveText(
    "Review again (1)",
  );
  await chooseOption(
    dialog.getByLabel("Selection preset"),
    "Unreviewed cards (10)",
  );
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(10);
  await expect(dialog.getByRole("checkbox").nth(0)).not.toBeChecked();
  await expect(dialog.getByRole("checkbox").nth(1)).not.toBeChecked();
  const search = dialog.getByRole("searchbox", { name: "Search cards" });
  await search.fill("cArd 12");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await search.press("Enter");
  await expect(dialog.getByRole("checkbox")).toHaveCount(1);
  expect(posts).toEqual([]);
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await search.fill("#2");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Selected only" }).click();
  await dialog.getByRole("checkbox").press("Space");
  await expect(
    dialog.getByRole("button", { name: "Selected only" }),
  ).toBeFocused();
  await expect(dialog.getByText("No matches for this search.")).toBeVisible();
  await dialog.getByRole("button", { name: "Show all items" }).click();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(10);
  await dialog.getByRole("button", { name: "Selected only" }).click();
  await search.fill("#12");
  await expect(dialog.getByRole("status")).toHaveText(
    "10 of 12 selected · 1 shown",
  );
  const subset = {
    ...deck,
    cards: deck.cards.slice(2),
    title: "Review · Practice cards",
  };
  await page.route("**/api/sets?requestId=*", (route) => {
    expect(route.request().postDataJSON()).toEqual(subset);
    return route.fulfill({ json: { id: "saved-deck", title: subset.title } });
  });
  await page.route("**/api/sets/saved-deck", (route) =>
    route.fulfill({ json: { id: "saved-deck", content: subset } }),
  );
  await dialog.getByRole("button", { name: "Save to library" }).click();
  await dialog.getByRole("link", { name: "Print worksheet" }).click();
  await expect(
    page
      .getByRole("list", { name: "Worksheet prompts" })
      .locator(":scope > li"),
  ).toHaveCount(10);
  await page.getByRole("link", { name: "Results", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Session complete" }),
  ).toBeVisible();
});

const worksheetExam: StudyContent = {
  ...content,
  title: "Algebra practice",
  questions: [
    {
      id: "choice",
      type: "single_choice",
      prompt: "Which expression equals $x + x$?",
      options: [
        { id: "sq", text: "$x^2$" },
        { id: "twice", text: "$2x$" },
      ],
      answer: "twice",
      explanation: "Adding one copy of $x$ to another gives two copies of $x$.",
    },
    {
      id: "written",
      type: "written",
      prompt: "Solve $3x + 1 = 10$. Show your work.",
      answer: "Subtract one to get $3x = 9$. Divide by three to get $x = 3$.",
      rubric: [{ id: "work", description: "Shows both operations", points: 2 }],
    },
  ],
};

for (const doc of [worksheetExam, deck]) {
  test(`prints the ${doc.kind} worksheet with an optional separate answer key`, async ({
    page,
  }) => {
    await fixture(page, doc);
    await page.route("**/api/sets/set", (route) =>
      route.fulfill({ json: { id: "set", content: doc } }),
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/library?search=practice");
    await page
      .getByText(`Actions for ${doc.title}`, { exact: true })
      .locator("..")
      .click();
    await page.getByRole("link", { name: "Print worksheet" }).click();
    await expect(page).toHaveURL(/\/sets\/set\/worksheet$/);
    await expect(page).toHaveTitle(`${doc.title} — Worksheet`);
    const prompts = page.getByRole("list", { name: "Worksheet prompts" });
    await expect(prompts.locator(":scope > li")).toHaveCount(
      itemsOf(doc).length,
    );
    const key = page.getByRole("region", { name: "Answer key" });
    await expect(key).toHaveCount(0);
    const solution = doc.kind === "exam" ? "Shows both operations" : "Answer";
    await expect(page.getByText(solution, { exact: true })).toHaveCount(0);
    const printContent = page.getByLabel("Print content");
    const space = page.getByLabel("Writing space");
    const writingLines = prompts
      .locator(".worksheet-writing-space")
      .first()
      .locator("span");
    await expect(writingLines).toHaveCount(2);
    await chooseOption(space, "6 lines");
    await expect(writingLines).toHaveCount(6);
    await chooseOption(space, "No lines");
    await expect(writingLines).toHaveCount(0);
    await chooseOption(space, "4 lines");
    await chooseOption(printContent, "Answer key only");
    await expect(prompts).toHaveCount(0);
    await expect(space).toHaveCount(0);
    await expect(page).toHaveTitle(`${doc.title} — Answer key`);
    await page.pdf({ path: `/tmp/examprep-key-${doc.kind}.pdf`, format: "A4" });
    await chooseOption(printContent, "Worksheet and answer key");
    await expect(writingLines).toHaveCount(4);
    await expect(
      key.getByText(solution, { exact: true }).first(),
    ).toBeVisible();
    if (doc.kind === "exam") {
      await expect(key.getByText("B.", { exact: true })).toBeVisible();
      await expect(key.getByText("2 pts", { exact: true })).toBeVisible();
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `/tmp/examprep-worksheet-${width}.png`,
          animations: "disabled",
        });
      }
    }
    await page.evaluate(() => {
      window.print = () => {
        document.documentElement.dataset.printed = "yes";
      };
    });
    await page.getByRole("button", { name: "Print or save PDF" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-printed", "yes");
    await page.emulateMedia({ media: "print" });
    await expect(printContent).toBeHidden();
    await expect(key).toHaveCSS("break-before", "page");
    await page.pdf({
      path: `/tmp/examprep-worksheet-${doc.kind}.pdf`,
      format: "A4",
      margin: { top: "14mm", bottom: "14mm", left: "14mm", right: "14mm" },
    });
    await page.emulateMedia({ media: "screen" });
    await chooseOption(printContent, "Worksheet only");
    await expect(key).toHaveCount(0);
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await expect(page).toHaveURL(/search=practice$/);
    expect(errors).toEqual([]);
  });
}

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
