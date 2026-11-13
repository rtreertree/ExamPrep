import { chooseOption } from "./selector";
import { test, expect, type Page } from "@playwright/test";
import {
  grade,
  mistakes,
  unreviewedCards,
  validateProgressChanges,
} from "../../shared/attempts";
import {
  itemsOf,
  validateContent,
  type StudyContent,
} from "../../shared/content";
import type { Attempt, StudySet } from "../../client/lib/api";

// Browser plugin not available. Run the repository's Playwright workflow with isolated API fixtures.
test.setTimeout(45_000);
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      ["error", "warning"].includes(m.type()) &&
      !m.text().includes("Failed to load resource")
    )
      errors.push(m.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});
const written: StudyContent = {
  schemaVersion: 1,
  kind: "exam",
  title: "Reliable study",
  questions: [0, 1, 2].map((i) => ({
    id: `q${i}`,
    type: "written",
    prompt: `Explain ${i + 1}`,
    answer: "Reference",
  })),
};
const mixed: StudyContent = {
  schemaVersion: 1,
  kind: "exam",
  title: "Mixed assessment",
  questions: [
    {
      id: "choice",
      type: "single_choice",
      prompt: "Choose",
      options: [
        { id: "a", text: "One" },
        { id: "b", text: "Two" },
      ],
      answer: "b",
    },
    {
      id: "binary",
      type: "written",
      prompt: "Explain in words",
      answer: "Reference one",
    },
    {
      id: "rubric",
      type: "written",
      prompt: "Show steps",
      answer: "Reference two",
      rubric: [
        { id: "one", description: "First step", points: 1 },
        { id: "two", description: "Second step", points: 2 },
      ],
    },
    {
      id: "blank",
      type: "written",
      prompt: "Optional response",
      answer: "Reference three",
    },
  ],
};
async function fixture(page: Page, doc = written, position = 0) {
  const now = new Date().toISOString();
  let set: StudySet = {
    id: "set",
    title: doc.title,
    kind: doc.kind,
    content: structuredClone(doc),
    revision: 1,
    ownershipRole: "primary",
    updatedAt: now,
    course: "",
    pinned: false,
    archived: false,
    lastStudiedAt: null,
    count: doc.kind === "exam" ? doc.questions.length : doc.cards.length,
  };
  let attempt: Attempt = {
    id: "attempt",
    snapshot: structuredClone(doc),
    responses: {},
    status: "in_progress",
    result: null,
    revision: 1,
    position,
    startedAt: now,
    studySetId: "set",
    studySetRevision: 1,
    sourceAttemptId: null,
  };
  let copy: StudySet | undefined;
  const state = {
    signedIn: true,
    userId: "student-a",
    signouts: 0,
    starts: 0,
    submitFailures: 0,
    logoutFailures: 0,
    editorLoadFailures: 0,
    listDelay: undefined as Promise<void> | undefined,
    delay: undefined as (() => Promise<void>) | undefined,
    set: () => set,
    attempt: () => attempt,
    requests: [] as string[],
    retries: [] as { mode?: string; snapshot: StudyContent }[],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    state.requests.push(path + url.search);
    let value: unknown;
    let status = 200;
    if (path === "/api/auth/get-session")
      value = state.signedIn
        ? { user: { id: state.userId, email: "student@example.test" } }
        : null;
    else if (path === "/api/auth/sign-out") {
      state.signouts++;
      if (state.logoutFailures-- > 0) {
        status = 503;
        value = { error: "Sign-out temporarily failed. Retry." };
      } else {
        state.signedIn = false;
        value = { success: true };
      }
    } else if (path === "/api/auth/sign-in/email") {
      state.signedIn = true;
      value = { success: true };
    } else if (path === "/api/account/recovery") {
      value = { enabled: true };
    } else if (path === "/api/ownership-invitations") {
      value = [];
    } else if (path === "/api/sets") {
      if (req.method() === "POST") {
        const content = validateContent(req.postDataJSON());
        set = {
          ...set,
          id: "imported",
          content,
          title: content.title,
          kind: content.kind,
          count:
            content.kind === "exam"
              ? content.questions.length
              : content.cards.length,
        };
        value = set;
      } else {
        await state.listDelay;
        value = {
          items: [
            {
              ...set,
              continuation:
                set.id === "set"
                  ? {
                      id: attempt.id,
                      position: attempt.position,
                      status: attempt.status,
                      result: attempt.result,
                      total: itemsOf(attempt.snapshot).length,
                      isOlderVersion: attempt.studySetRevision !== set.revision,
                      kind: attempt.snapshot.kind,
                    }
                  : null,
            },
          ].filter(
            (item) =>
              item.title
                .toLowerCase()
                .includes(
                  (url.searchParams.get("search") ?? "").toLowerCase(),
                ) &&
              (!url.searchParams.get("kind") ||
                item.kind === url.searchParams.get("kind")) &&
              (!url.searchParams.has("course") ||
                item.course === url.searchParams.get("course")) &&
              item.archived === (url.searchParams.get("archived") === "true"),
          ),
          hasMore: false,
          courses: set.course ? [set.course] : [],
          page: Number(url.searchParams.get("page")),
        };
      }
    } else if (path === `/api/sets/${set.id}`) {
      if (req.method() === "GET" && state.editorLoadFailures > 0) {
        state.editorLoadFailures--;
        status = 503;
        value = { error: "The study set is temporarily unavailable." };
      } else {
        if (req.method() === "PUT") {
          const content = validateContent(req.postDataJSON().content);
          set = {
            ...set,
            content,
            title: content.title,
            count: itemsOf(content).length,
            revision: set.revision + 1,
          };
        }
        value = set;
      }
    } else if (path === "/api/sets/set/organization") {
      set = { ...set, ...req.postDataJSON() };
      value = { updated: true };
    } else if (path === "/api/sets/set/duplicate") {
      const title = `Copy of ${set.title}`;
      copy = {
        ...set,
        id: "set-copy",
        title,
        content: { ...structuredClone(set.content), title },
        pinned: false,
        archived: false,
        lastStudiedAt: null,
        revision: 1,
      };
      value = copy;
    } else if (path === "/api/sets/set-copy") {
      value = copy;
    } else if (path === "/api/sets/set/attempts") {
      state.starts++;
      value = { ...attempt, id: "fresh" };
    } else if (path === "/api/attempts")
      value = {
        items: [{ ...attempt, title: doc.title }].filter(
          (item) =>
            item.title
              .toLowerCase()
              .includes((url.searchParams.get("search") ?? "").toLowerCase()) &&
            [
              null,
              "all",
              item.status,
              item.status === "completed" ? "completed" : "attention",
            ].includes(url.searchParams.get("status")),
        ),
        hasMore: false,
      };
    else if (path === "/api/attempts/attempt") value = attempt;
    else if (path === "/api/attempts/fresh")
      value = {
        ...attempt,
        id: "fresh",
        snapshot: state.retries.at(-1)?.snapshot ?? set.content,
        responses: {},
        status: "in_progress",
        result: null,
        position: 0,
      };
    else if (path === "/api/attempts/attempt/retry") {
      const { mode } = req.postDataJSON();
      const snapshot = (mode === "unreviewed" ? unreviewedCards : mistakes)(
        attempt.snapshot,
        attempt.responses,
      );
      if (!snapshot) throw new Error("Expected a retry subset");
      state.retries.push({ mode, snapshot });
      value = {
        ...attempt,
        id: "fresh",
        snapshot,
        responses: {},
        status: "in_progress",
        result: null,
        position: 0,
      };
    } else if (path === "/api/attempts/attempt/progress") {
      const body = req.postDataJSON();
      if (state.delay) await state.delay();
      if (body.revision !== attempt.revision) {
        status = 409;
        value = { error: "Newer revision" };
      } else {
        const responses = validateProgressChanges(
          attempt.snapshot,
          attempt.status,
          attempt.responses,
          body.changes,
          body.position,
        );
        attempt = {
          ...attempt,
          responses,
          position: body.position,
          revision: attempt.revision + 1,
          ...(attempt.status === "reviewing"
            ? grade(attempt.snapshot, responses)
            : {}),
        };
        const { responses: _, snapshot: __, ...metadata } = attempt;
        value = metadata;
      }
    } else if (path === "/api/attempts/attempt/submit") {
      if (state.submitFailures-- > 0) {
        status = 503;
        value = { error: "Submission failed. Please retry." };
      } else {
        attempt = {
          ...attempt,
          ...grade(attempt.snapshot, attempt.responses),
          revision: attempt.revision + 1,
        };
        const { responses: _, snapshot: __, ...metadata } = attempt;
        value = metadata;
      }
    } else throw new Error(`Unexpected request ${path}`);
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  });
  return state;
}
function gate() {
  let release!: () => void, started!: () => void;
  const opened = new Promise<void>((r) => (started = r));
  const wait = new Promise<void>((r) => (release = r));
  return {
    release,
    opened,
    delay: async () => {
      started();
      await wait;
    },
  };
}
for (const mode of ["Next", "Previous", "picker"] as const) {
  test(`latest answer survives delayed ${mode} navigation and reload`, async ({
    page,
  }) => {
    const api = await fixture(page, written, mode === "Previous" ? 1 : 0);
    if (mode === "picker")
      await page.setViewportSize({ width: 390, height: 844 });
    const hold = gate();
    let calls = 0;
    api.delay = async () => {
      if (calls++ === 0) await hold.delay();
    };
    await page.goto("/practice/attempt");
    await expect(page).toHaveTitle("Exam Prep");
    const answer = page.getByLabel("Your answer", { exact: true });
    await answer.fill("Initial answer");
    if (mode === "picker") {
      await page.getByRole("button", { name: "Question 1 of 3" }).click();
      await page
        .getByRole("button", { name: "Question 2, Unanswered", exact: true })
        .click({ noWaitAfter: true });
      // Dialog remains open until the save confirms; close it to continue editing.
      await page
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
    } else
      await page
        .getByRole("button", { name: mode, exact: true })
        .click({ noWaitAfter: true });
    await hold.opened;
    await answer.fill("Latest answer typed while saving 🦊");
    hold.release();
    const target = mode === "Previous" ? 0 : 1;
    await expect(
      page.getByRole("heading", { name: `Question ${target + 1} of 3` }),
    ).toBeFocused();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    const original = mode === "Previous" ? 1 : 0;
    expect(api.attempt().responses[`q${original}`].text).toBe(
      "Latest answer typed while saving 🦊",
    );
    await page
      .getByRole("button", {
        name: mode === "Previous" ? "Next" : "Previous",
        exact: true,
      })
      .click();
    await expect(answer).toHaveValue("Latest answer typed while saving 🦊");
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(answer).toHaveValue("Latest answer typed while saving 🦊");
  });
}
test("storage failure cannot prevent sign-out; server failure remains in the dialog", async ({
  page,
}) => {
  await page.addInitScript(() => {
    indexedDB.open = () => {
      throw new Error("Storage blocked");
    };
  });
  const api = await fixture(page);
  api.logoutFailures = 1;
  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign out and clear drafts" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Sign-out temporarily failed",
  );
  await page.getByRole("button", { name: "Sign out and clear drafts" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByText("You are signed out. Some local study data", {
      exact: false,
    }),
  ).toBeVisible();
  expect(api.signouts).toBe(2);
  expect(api.signedIn).toBe(false);
});
test("submission failure retains context; guided assessment commits partial rubrics and explicit zeros", async ({
  page,
}) => {
  const api = await fixture(page, mixed);
  api.attempt().responses = {
    choice: { selectedOptionId: "a", flagged: true },
    binary: { text: "My reasoning" },
    rubric: { text: "My steps" },
  };
  api.submitFailures = 1;
  await page.goto("/practice/attempt");
  await page
    .getByRole("button", { name: "Review and submit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("3 answered, 1 unanswered, 1 flagged");
  await expect(dialog).toContainText(
    "You’ll assess your written answers next.",
  );
  await dialog.getByText("Review unanswered questions").click();
  await expect(
    dialog.getByRole("button", { name: "Question 4", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Submit exam" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Submission failed");
  expect(api.attempt().status).toBe("in_progress");
  await dialog.getByRole("button", { name: "Submit exam" }).click();
  await expect(
    page.getByRole("heading", { name: "Finish self-assessment" }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Question 2 of 4" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Your submitted answer" }),
  ).toContainText("My reasoning");
  await expect(
    page.getByRole("region", { name: "Reference answer" }),
  ).toContainText("Reference one");
  const comparison = page.locator(".exam-answer-comparison");
  await expect(comparison).toHaveCSS(
    "grid-template-columns",
    /^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(comparison).toHaveCSS(
    "grid-template-columns",
    /^\d+(?:\.\d+)?px$/,
  );
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page
    .getByRole("button", { name: "Correct · 1 point", exact: true })
    .click();
  await expect(
    page.getByText("1 of 2 written answers assessed.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next unassessed answer" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/examprep-v1-assessment-desktop.png",
    animations: "disabled",
  });
  const one = page.getByLabel("Points for criterion 1 (maximum 1)");
  await one.fill("1");
  await one.press("Enter");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(api.attempt().status).toBe("reviewing");
  const hold = gate();
  api.delay = hold.delay;
  const two = page.getByLabel("Points for criterion 2 (maximum 2)");
  await two.fill("0");
  await two.press("Enter");
  await hold.opened;
  await expect(
    page.getByRole("heading", { name: "Finish self-assessment" }),
  ).toBeVisible();
  await expect(
    page.getByText("1 of 2 written answers assessed.", { exact: false }),
  ).toBeVisible();
  hold.release();
  await expect(
    page.getByRole("heading", { name: "Exam results" }),
  ).toBeFocused();
  expect(api.attempt().status).toBe("completed");
  expect(api.attempt().result?.selfAssessed).toEqual({
    earnedPoints: 2,
    maxPoints: 5,
    pendingCount: 0,
  });
  const map = page.getByRole("complementary", { name: "Question navigation" });
  await expect(
    map.getByRole("button", { name: "Question 1, Incorrect, flagged" }),
  ).toBeVisible();
  await expect(
    map.getByRole("button", { name: "Question 2, Correct" }),
  ).toBeVisible();
  await expect(
    map.getByRole("button", { name: "Question 3, Partial credit" }),
  ).toBeVisible();
  await expect(
    map.getByRole("button", { name: "Question 4, Unanswered" }),
  ).toBeVisible();
  await chooseOption(map.getByLabel("Filter questions"), "Needs review");
  await expect(map.getByRole("button")).toHaveCount(3);
  await page.getByRole("button", { name: "Review first mistake" }).click();
  await expect(
    page.getByRole("heading", { name: "Question 1 of 4" }),
  ).toBeFocused();
  await expect(page.getByText("Your choice", { exact: true })).toBeVisible();
  await expect(page.getByText("Correct answer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry mistakes (3)" }).click();
  await expect(page).toHaveURL(/\/practice\/fresh$/);
  await expect(
    page.getByRole("progressbar", { name: "Questions answered" }),
  ).toHaveJSProperty("value", 0);
  const retry = api.retries.at(-1);
  expect(retry?.mode).toBe("mistakes");
  expect(
    retry?.snapshot.kind === "exam" &&
      retry.snapshot.questions.map(({ id }) => id),
  ).toEqual(["choice", "rubric", "blank"]);
});
test("library resumes without duplication and import has a bounded preview and explicit destination", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("link", { name: "Resume — question 1 of 3" }).click();
  await expect(page.getByLabel("Your answer", { exact: true })).toBeVisible();
  expect(api.starts).toBe(0);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("tab", { name: "Flashcards", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("tab", { name: "Paste JSON" }).click();
  const large = {
    schemaVersion: 1,
    kind: "exam",
    title: "Imported 500",
    questions: Array.from({ length: 500 }, (_, i) => ({
      id: `q${i}`,
      type: "written",
      prompt: `Question ${i + 1}`,
      answer: "Answer",
    })),
  };
  await page.getByLabel("Study-set JSON").fill(JSON.stringify(large));
  await page.getByRole("button", { name: "Validate and preview" }).click();
  await expect(page.locator(".content-preview > section")).toHaveCount(1);
  const previewItem = page.getByRole("combobox", { name: "Preview item" });
  await previewItem.press("End");
  const lastItem = page.getByRole("option", { name: "Item 500", exact: true });
  await expect(lastItem).toBeInViewport({ ratio: 0.9 });
  await previewItem.press("Enter");
  await expect(previewItem).toHaveText("Item 500");
  await expect(page.locator(".content-preview")).toContainText("Question 500");
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(
    page.getByText("“Imported 500” is saved to your account."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start practice", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Edit set", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "All", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/examprep-v1-library-mobile.png",
    animations: "disabled",
  });
});
test("AI settings survive closing, remain account scoped, and search filters reach the server", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/");
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Create with your AI" }),
  ).toBeVisible();
  await page
    .getByLabel("Topic or source material")
    .fill("Private student A notes");
  await page.getByText("Customize", { exact: true }).click();
  await page.getByLabel("Set exact counts by question type").check();
  await page.getByLabel("True/false questions").fill("3");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await expect(page.getByLabel("Topic or source material")).toHaveValue(
    "Private student A notes",
  );
  await expect(page.getByLabel("Total questions")).toHaveText("13 questions");
  await page.getByText("Customize", { exact: true }).click();
  await expect(page.getByLabel("True/false questions")).toHaveValue("3");
  api.userId = "student-b";
  await page.reload();
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await expect(page.getByLabel("Topic or source material")).toHaveValue("");
  await expect(page.getByLabel("Item count")).toHaveValue("10");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  let release!: () => void;
  api.listDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByLabel("Search library").fill("beyond page one");
    await expect
      .poll(() =>
        api.requests.some(
          (p) =>
            new URL(p, "http://localhost").searchParams.get("search") ===
            "beyond page one",
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole("link", { name: "Reliable study", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("status", { name: "Updating study sets" }),
    ).toBeVisible();
    await expect(page.getByLabel("Search library")).toHaveValue(
      "beyond page one",
    );
  } finally {
    release();
    api.listDelay = undefined;
  }
  await expect(
    page.getByText("No study sets match this search."),
  ).toBeVisible();
  await page.goto("/history");
  await page.getByRole("tab", { name: "Needs attention", exact: true }).click();
  await page.getByLabel("Search history").fill("unfinished");
  await expect
    .poll(() =>
      api.requests.some(
        (p) =>
          p.includes("status=attention") && p.includes("search=unfinished"),
      ),
    )
    .toBe(true);
});

test("AI helper copies a custom exam and imports its result for editing", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const api = await fixture(page);
  await page.goto("/");
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  const helper = page.getByRole("dialog", { name: "Create with your AI" });
  const copy = helper.getByRole("button", { name: "Copy prompt" });
  await expect(copy).toBeDisabled();
  await helper.getByLabel("Topic or source material").fill("Photosynthesis");
  const count = helper.getByLabel("Item count");
  await count.fill("501");
  await expect(copy).toBeDisabled();
  await count.fill("4.5");
  await expect(copy).toBeDisabled();
  await count.fill("3");
  await expect(copy).toBeEnabled();
  await helper.getByText("Customize", { exact: true }).click();
  const exact = helper.getByLabel("Set exact counts by question type");
  await exact.check();
  const choice = helper.getByLabel("Multiple-choice questions");
  const trueFalse = helper.getByLabel("True/false questions");
  const writtenCount = helper.getByLabel("Written questions");
  await expect(choice).toHaveValue("2");
  await expect(writtenCount).toHaveValue("1");
  await writtenCount.fill("0");
  await expect(helper.getByLabel("Written-question rubrics")).toHaveCount(0);
  await choice.fill("0");
  await expect(copy).toBeDisabled();
  await trueFalse.fill("2");
  await writtenCount.fill("500");
  await expect(helper.getByLabel("Total questions")).toHaveText(
    "502 questions",
  );
  await expect(copy).toBeDisabled();
  await writtenCount.fill("1");
  await chooseOption(
    helper.getByLabel("Written-question rubrics"),
    "For every written question",
  );
  await chooseOption(
    helper.getByLabel("Answer explanations"),
    "Detailed explanations",
  );
  await exact.uncheck();
  await expect(count).toHaveValue("3");
  await exact.check();
  const kind = helper.getByLabel("Content type");
  await chooseOption(kind, "Flashcards");
  await expect(count).toHaveValue("3");
  await chooseOption(kind, "Exam");
  await expect(trueFalse).toHaveValue("2");
  await expect(helper.getByLabel("Total questions")).toHaveText("3 questions");
  await helper.screenshot({
    path: "/tmp/examprep-ai-library-desktop.png",
    animations: "disabled",
  });
  await copy.click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  expect(prompt).toContain(
    "exactly 0 multiple-choice, 2 true/false, and 1 written questions",
  );
  expect(prompt).toContain("exactly two options for true and false");
  expect(prompt).toContain("detailed explanation for each answer");
  expect(prompt).toContain("marking rubric for every written question");
  await helper.getByRole("button", { name: "Import AI result" }).click();

  const importer = page.getByRole("dialog", { name: "Import a study set" });
  await expect(
    importer.getByRole("tab", { name: "Paste JSON" }),
  ).toHaveAttribute("aria-selected", "true");
  const input = importer.getByLabel("Study-set JSON");
  const validate = importer.getByRole("button", {
    name: "Validate and preview",
  });
  const doc = {
    schemaVersion: 1,
    kind: "exam",
    title: "Photosynthesis review",
    questions: [
      {
        id: "q1",
        type: "single_choice",
        prompt: "Plants release oxygen during photosynthesis.",
        options: [
          { id: "true", text: "True" },
          { id: "false", text: "False" },
        ],
        answer: "true",
        explanation: "Oxygen is released when water is split.",
      },
      {
        id: "q2",
        type: "single_choice",
        prompt: "Plants release oxygen during photosynthesis.",
        options: [
          { id: "true", text: "True" },
          { id: "false", text: "False" },
        ],
        answer: "true",
        explanation: "Splitting water releases oxygen.",
      },
      {
        id: "q3",
        type: "written",
        prompt: "What are the products of photosynthesis?",
        answer: "Carbohydrates and oxygen.",
        explanation: "The process stores energy in sugars.",
        rubric: [
          { id: "products", description: "Names both products", points: 2 },
        ],
      },
    ],
  } satisfies StudyContent;
  await input.fill('{"kind":');
  await validate.click();
  await expect(
    importer
      .getByRole("alert")
      .getByText("Study set: Expected a JSON value (line 1, column 9).", {
        exact: true,
      }),
  ).toBeVisible();
  await expect(
    importer.getByRole("button", { name: "Save to library" }),
  ).toHaveCount(0);
  const badChoice = { ...mixed.questions[0], answer: "missing" };
  await input.fill(
    "```json\n" + JSON.stringify({ ...doc, questions: [badChoice] }) + "\n```",
  );
  await validate.click();
  await expect(
    importer.getByText(
      "Question 1, answer: Answer must match an option ID in this question.",
      { exact: true },
    ),
  ).toBeVisible();
  await importer.getByRole("button", { name: "Copy feedback for AI" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "/questions/0/answer",
  );
  await input.fill(
    JSON.stringify({ ...doc, questions: doc.questions.slice(0, 1) }),
  );
  await validate.click();
  const save = importer.getByRole("button", { name: "Save to library" });
  await expect(save).toBeDisabled();
  await expect(
    importer.getByText("Study set: Expected 3 items; found 1.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    importer.getByRole("heading", { name: doc.title }),
  ).toBeVisible();
  await importer.getByRole("button", { name: "Copy feedback for AI" }).click();
  const feedback = await page.evaluate(() => navigator.clipboard.readText());
  expect(feedback).toContain("Items: exactly 3");
  expect(feedback).toContain(
    "[/questions]: Study set: Expected 3 items; found 1.",
  );
  expect(feedback).toContain(
    "Preserve unaffected items, their IDs, and their order",
  );
  await input.fill("```json\n" + JSON.stringify(doc) + "\n```");
  await expect(save).toHaveCount(0);
  await validate.click();
  await expect(
    importer.getByRole("heading", { name: doc.title }),
  ).toBeVisible();
  await expect(
    importer.getByText("Possible repetitions to review"),
  ).toBeVisible();
  await expect(save).toBeEnabled();
  await importer
    .getByRole("button", { name: "Copy answer review prompt" })
    .click();
  const audit = await page.evaluate(() => navigator.clipboard.readText());
  expect(audit).toContain("Solve each question independently");
  expect(audit).toContain("Report each finding by item ID");
  await save.click();
  expect(api.set().content).toEqual(doc);
  await page.getByRole("link", { name: "Edit set", exact: true }).click();
  await expect(page).toHaveURL(/\/sets\/imported\/edit$/);
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    doc.title,
  );
});

test("mobile AI helper offers manual copying and file upload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: () => Promise.reject(new Error("Clipboard blocked")),
    });
  });
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  const helper = page.getByRole("dialog", { name: "Create with your AI" });
  await helper.getByLabel("Topic or source material").fill("Calculus");
  await expect(helper.getByLabel("Item count")).toHaveValue("10");
  await helper.getByLabel("Item count").fill("3");
  await helper.getByRole("button", { name: "Copy prompt" }).press("Enter");
  const preview = helper.getByLabel("Prompt to copy");
  await expect(preview).toBeFocused();
  await expect(preview).toHaveValue(
    /include both multiple-choice and written questions/,
  );
  await expect(
    helper.getByText(
      "Clipboard access failed. Copy the selected prompt manually.",
    ),
  ).toBeVisible();
  expect(
    await preview.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      return (
        textarea.selectionStart === 0 &&
        textarea.selectionEnd === textarea.value.length
      );
    }),
  ).toBe(true);
  expect(
    await helper.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
  ).toBe(true);
  await helper.getByRole("button", { name: "Import AI result" }).click();
  const importer = page.getByRole("dialog", { name: "Import a study set" });
  await importer.getByRole("tab", { name: "Choose file" }).click();
  const upload = importer.getByLabel("Choose a JSON file");
  const incorrect = { ...written, questions: written.questions.slice(0, 1) };
  await upload.setInputFiles({
    name: "calculus.examprep.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(incorrect)),
  });
  await expect(
    importer.getByRole("heading", { name: written.title }),
  ).toBeVisible();
  await expect(
    importer.getByRole("button", { name: "Save to library" }),
  ).toBeDisabled();
  await importer.getByRole("button", { name: "Copy feedback for AI" }).click();
  const feedback = importer.getByLabel("Feedback for AI", { exact: true });
  await expect(feedback).toBeFocused();
  await expect(feedback).toHaveValue(/Expected 3 items; found 1/);
  await expect(importer.getByLabel("Original imported source")).toHaveValue(
    JSON.stringify(incorrect),
  );
  await expect(importer.getByLabel("Original imported source")).toBeVisible();
  await importer.getByRole("tab", { name: "Paste JSON" }).click();
  await expect(importer.getByLabel("Study-set JSON")).toHaveValue(
    JSON.stringify(incorrect),
  );
  await importer.getByRole("tab", { name: "Choose file" }).click();
  const corrected = {
    ...written,
    title: "Corrected calculus review",
    questions: written.questions.map((question) => ({
      ...question,
      explanation: "The reasoning behind this result.",
    })),
  };
  await upload.setInputFiles({
    name: "calculus.examprep.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(corrected)),
  });
  await expect(
    importer.getByRole("heading", { name: corrected.title }),
  ).toBeVisible();
  await expect(
    importer.getByRole("button", { name: "Copy feedback for AI" }),
  ).toHaveCount(0);
  await importer.getByRole("button", { name: "Save to library" }).click();
  await expect(
    page.getByText(`“${corrected.title}” is saved to your account.`),
  ).toBeVisible();
});

test("library resumes the saved snapshot and remembers course filters across practice", async ({
  page,
}) => {
  const mocked = await fixture(page, written, 2);
  await page.goto("/sets/set/edit");
  await page.getByRole("button", { name: "Remove item", exact: true }).click();
  await page.getByRole("button", { name: "Remove item", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← Library", exact: true }).click();
  await expect(
    page.getByText("Exam · 1 question", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Attempt uses an earlier set version"),
  ).toBeVisible();
  const actions = page
    .locator("summary")
    .filter({ hasText: "Actions for Reliable study" });
  await actions.click();
  await page.getByRole("button", { name: "Set course", exact: true }).click();
  await page.getByLabel("Course name").fill("Organic chemistry");
  await page.getByRole("button", { name: "Save course" }).click();
  await expect(page.locator(".set-meta")).toContainText("Organic chemistry");
  await actions.click();
  await page.getByRole("button", { name: "Pin set" }).click();
  await expect(page.locator(".set-meta")).toContainText("Pinned");
  await page.getByText("Library filters", { exact: true }).click();
  await chooseOption(
    page.getByLabel("Course", { exact: true }),
    "Organic chemistry",
  );
  await chooseOption(page.getByLabel("Sort library"), "Last studied");
  await page.getByLabel("Search library").pressSequentially("Reliable");
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("search") === "Reliable" &&
      url.searchParams.get("course") === "Organic chemistry" &&
      url.searchParams.get("sort") === "studied",
  );
  await expect
    .poll(() =>
      mocked.requests
        .map((path) => new URL(path, "http://localhost"))
        .filter(
          (url) =>
            url.pathname === "/api/sets" && url.searchParams.get("search"),
        )
        .map((url) => url.searchParams.get("search")),
    )
    .toEqual(["Reliable"]);
  await page.getByRole("link", { name: "Resume — question 3 of 3" }).click();
  await expect(
    page.getByRole("heading", { name: "Question 3 of 3" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.getByLabel("Course", { exact: true })).toHaveText(
    "Organic chemistry",
  );
  await expect(page.getByLabel("Sort library")).toHaveText("Last studied");
  await expect(page.getByLabel("Search library")).toHaveValue("Reliable");
  await page.screenshot({
    path: "/tmp/examprep-v1-library-organization-desktop.png",
    animations: "disabled",
  });
  await actions.click();
  await page.getByRole("button", { name: "Archive set", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Reliable study", exact: true }),
  ).toHaveCount(0);
  await chooseOption(page.getByLabel("Show sets"), "Archived");
  await expect(
    page.getByRole("link", { name: "Reliable study", exact: true }),
  ).toBeVisible();
  await actions.click();
  await page
    .getByRole("button", { name: "Duplicate set", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Copy of Reliable study", level: 1 }),
  ).toBeVisible();
});

test.describe("course suggestions on touch screens", () => {
  test.use({ hasTouch: true, reducedMotion: "reduce" });

  test("selects an existing course and accepts a blank name", async ({
    page,
  }) => {
    const api = await fixture(page, written);
    await page.goto("/");
    const actions = page
      .locator("summary")
      .filter({ hasText: "Actions for Reliable study" });
    await actions.tap();
    await page.getByRole("button", { name: "Set course", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "Set course" });
    const course = dialog.getByRole("combobox", { name: "Course name" });
    await course.fill("Organic chemistry");
    await dialog.getByRole("button", { name: "Save course" }).tap();
    await expect.poll(() => api.set().course).toBe("Organic chemistry");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".set-meta")).toContainText("Organic chemistry");

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 740 });
      await actions.tap();
      await page.getByRole("button", { name: "Set course", exact: true }).tap();
      await course.fill("chem");
      const list = dialog.getByRole("listbox");
      await expect(list).toBeVisible();
      await page.setViewportSize({ width, height: 460 });
      await expect(list).toHaveCSS("animation-name", "none");
      const bounds = await list.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(460);
      if (width === 320)
        await page.screenshot({
          path: "/tmp/examprep-selector-course-320.png",
        });
      await list.getByRole("option", { name: "Organic chemistry" }).tap();
      await expect(course).toHaveValue("Organic chemistry");
      await expect(course).toBeFocused();
      await expect(list).toBeHidden();
      await dialog.getByRole("button", { name: "Cancel" }).tap();
    }

    await actions.tap();
    await page.getByRole("button", { name: "Set course", exact: true }).tap();
    await course.fill("");
    await dialog.getByRole("button", { name: "Save course" }).tap();
    await expect.poll(() => api.set().course).toBe("");
    await expect(page.locator(".set-meta")).not.toContainText(
      "Organic chemistry",
    );
  });
});
test("editor searches inside answers, duplicates with a new ID and moves directly on mobile", async ({
  page,
}) => {
  const mocked = await fixture(page, mixed);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sets/set/edit");
  await page.getByRole("button", { name: "Search questions" }).click();
  await page.getByLabel("Find a question").fill("Second step");
  await expect(page.getByText("1 of 4 items match.")).toBeVisible();
  await chooseOption(page.getByLabel("Selected item", { exact: true }), /^3\./);
  await page.getByRole("button", { name: "Duplicate item" }).click();
  await expect(page.getByText("Item 4 of 5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Move item to position" }).click();
  await page.getByLabel("New position").fill("1");
  await page.getByRole("button", { name: "Move item", exact: true }).click();
  await expect(page.getByText("Item 1 of 5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  const items = itemsOf(mocked.set().content);
  const { id, ...original } = items[3];
  expect(id).toBe("rubric");
  expect(items[0].id).not.toBe(id);
  expect(items[0]).toEqual({ ...original, id: items[0].id });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/examprep-v1-editor-shortcuts-mobile.png",
    animations: "disabled",
  });
});
test("flashcard ratings can be undone without resetting reveal state", async ({
  page,
}) => {
  const doc: StudyContent = {
    schemaVersion: 1,
    kind: "flashcards",
    title: "Deck",
    cards: [
      { id: "one", front: "First?", back: "First answer" },
      { id: "two", front: "Second?", back: "Second answer" },
    ],
  };
  const api = await fixture(page, doc);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/practice/attempt");
  await page.getByRole("button", { name: "Reveal answer" }).click();
  await page.getByText("Show question", { exact: true }).click();
  await expect(page.getByText("First?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Known", exact: true }).click();
  await page.getByRole("button", { name: "Undo last rating" }).click();
  await expect(page.getByRole("button", { name: "Card 1 of 2" })).toBeVisible();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(api.attempt().responses.one).toEqual({ revealed: true });
  await page.getByRole("button", { name: "Review again", exact: true }).click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Finish session", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("1 rated, 1 unreviewed");
  await expect(
    page.getByRole("button", { name: "Go to next unreviewed card" }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Finish session", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Session complete" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo last rating" }),
  ).toHaveCount(0);
});

test("editor locates invalid fields, recovers unfinished content, and saves before practice", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/sets/set/edit");
  await page.getByRole("button", { name: "02 Explain 2", exact: true }).click();
  await page.getByLabel("Question", { exact: true }).fill("");
  await page.getByLabel("Question", { exact: true }).press("Tab");
  await expect(
    page.getByText("Draft saved on this device", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Question", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Answer type" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Restore draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Question 2, question: Enter some text.",
  );
  await page.getByRole("button", { name: "Next issue", exact: true }).click();
  await expect(page.getByLabel("Selected item", { exact: true })).toHaveText(
    /^2\./,
  );
  await expect(page.getByLabel("Question", { exact: true })).toBeFocused();
  await page.getByLabel("Question", { exact: true }).fill("Repaired prompt");
  await page
    .getByRole("button", { name: "Save and practice", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Set up exam" })
    .getByRole("button", { name: "Start exam", exact: true })
    .click();
  await expect(page).toHaveURL(/\/practice\/fresh$/);
  const saved = api.set().content;
  expect(saved.kind === "exam" && saved.questions[1].prompt).toBe(
    "Repaired prompt",
  );
  expect(api.starts).toBe(1);
});
test("import errors identify the field and preserve source for repair without saving", async ({
  page,
  context,
}) => {
  const api = await fixture(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const invalid = structuredClone(mixed);
  if (invalid.kind !== "exam" || invalid.questions[0].type !== "single_choice")
    throw new Error("Expected choice");
  invalid.questions[0].options[1].text = "";
  const source = JSON.stringify(invalid);
  await page.getByLabel("Choose a JSON file").setInputFiles({
    name: "invalid.examprep.json",
    mimeType: "application/json",
    buffer: Buffer.from(source),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Question 1, option B: Enter some text.",
  );
  await page.getByText("View original source", { exact: true }).click();
  await expect(page.getByLabel("Original imported source")).toHaveValue(source);
  await page.getByRole("button", { name: "Copy repair instructions" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "/questions/0/options/1/text",
  );
  await expect(
    page.getByRole("button", { name: "Save to library" }),
  ).toHaveCount(0);
  expect(api.set().title).toBe(written.title);
});
test("successful sign-out removes only the matching account's AI settings", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/account");
  await page.evaluate(() => {
    localStorage.setItem("exam-prep:ai:v1:student-a", "private-a");
    localStorage.setItem("exam-prep:ai:v1:student-b", "private-b");
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign out and clear drafts" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(api.signouts).toBe(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("exam-prep:ai:v1:student-a"),
    ),
  ).toBeNull();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("exam-prep:ai:v1:student-b"),
    ),
  ).toBe("private-b");
  await expect(
    page.getByRole("button", { name: "Retry device cleanup" }),
  ).toHaveCount(0);
});
test("AI helper warns before losing notes when device storage is blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Blocked");
    };
  });
  await fixture(page);
  await page.goto("/");
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await page.getByText("Customize", { exact: true }).click();
  await page.getByLabel("Extra instructions (optional)").fill("Keep my work");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByText("Your changes have not been saved on this device.", {
      exact: false,
    }),
  ).toBeVisible();
  const keepEditing = page.getByRole("button", { name: "Keep editing" });
  await expect(keepEditing).toBeFocused();
  await keepEditing.press("Enter");
  await expect(page.getByLabel("Extra instructions (optional)")).toHaveValue(
    "Keep my work",
  );
});

test("empty library exposes all three starting paths without a menu", async ({
  page,
}) => {
  await fixture(page);
  await page.route("**/api/sets**", (route) =>
    new URL(route.request().url()).pathname === "/api/sets"
      ? route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ items: [], hasMore: false }),
        })
      : route.fallback(),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Import a study set", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create one manually", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Prepare one with my AI tool",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview a sample" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "does not add content to your account",
  );
});
test("a hanging device store cannot trap a signed-out student", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/account");
  await page.evaluate(async () => {
    const original = indexedDB.open.bind(indexedDB);
    await new Promise<void>((resolve, reject) => {
      const req = original("exam-prep-drafts", 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore("drafts", {
          keyPath: ["userId", "key"],
        });
        store.createIndex("account", "userId");
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => {};
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    indexedDB.open = (name: string) => original(name, 2);
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign out and clear drafts" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry device cleanup" }),
  ).toBeVisible();
  expect(api.signedIn).toBe(false);
});
test("formula insertion follows the same Unicode length validation as typed text", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/sets/set/edit");
  const answer = page.getByLabel("Reference answer", { exact: true });
  await answer.fill("🦊".repeat(20_000));
  const field = page.locator(".field").filter({ has: answer });
  await field.getByRole("button", { name: "Symbols", exact: true }).click();
  await field
    .getByRole("button", { name: "Math keyboard", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("LaTeX source", { exact: true }).fill("x");
  await dialog
    .getByRole("button", { name: "Insert formula", exact: true })
    .click();
  await expect(answer).toHaveAttribute("aria-invalid", "true");
  await expect(field).toContainText("20,003 / 20,000 characters");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "at most 20000 Unicode characters",
  );
  expect(api.set().revision).toBe(1);
});

test("removing the correct option requires an explicit replacement and Undo preserves later edits", async ({
  page,
}) => {
  const doc = structuredClone(mixed);
  if (doc.kind !== "exam" || doc.questions[0].type !== "single_choice")
    throw new Error("Expected choice");
  doc.questions[0].options.push({ id: "c", text: "Three" });
  const api = await fixture(page, doc);
  await page.goto("/sets/set/edit");
  await page
    .getByRole("button", { name: "Remove option 2", exact: true })
    .click();
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveText(
    "Select a correct answer",
  );
  await expect(
    page.getByText(
      "The correct option was removed. Select a replacement correct answer.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Selected item")).toContainText(
    "Needs attention",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Some fields need attention",
  );
  const correctAnswer = page.getByLabel("Correct answer", { exact: true });
  await page.getByRole("button", { name: "Next issue", exact: true }).click();
  await expect(correctAnswer).toBeFocused();
  await expect(correctAnswer).toHaveAttribute("aria-invalid", "true");
  await correctAnswer.press("Space");
  await expect(
    page.getByRole("option", { name: "Select a correct answer" }),
  ).toBeDisabled();
  await correctAnswer.press("Home");
  const activeOption = await correctAnswer.getAttribute(
    "aria-activedescendant",
  );
  await expect(page.locator(`[id="${activeOption}"]`)).toHaveText("Option A");
  await correctAnswer.press("Escape");
  await expect(correctAnswer).toHaveText("Select a correct answer");
  expect(api.set().revision).toBe(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveText(
    "Option B",
  );
  await expect(page.getByLabel("Option B", { exact: true })).toHaveValue("Two");
  await page
    .getByRole("button", { name: "Remove option 2", exact: true })
    .click();
  await chooseOption(
    page.getByLabel("Correct answer", { exact: true }),
    "Option B",
  );
  await page
    .getByLabel("Question", { exact: true })
    .fill("Edited after removal");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Correct answer", { exact: true })).toHaveText(
    "Option C",
  );
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue(
    "Edited after removal",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => api.set().revision).toBe(2);
  const saved = api.set().content;
  expect(saved.kind === "exam" && saved.questions[0]).toMatchObject({
    answer: "c",
    options: doc.questions[0].options,
  });
});

test("Undo restores a complete question at its position and the last rubric criterion", async ({
  page,
}) => {
  const doc = structuredClone(mixed);
  if (doc.kind !== "exam") throw new Error("Expected exam");
  doc.questions[2].explanation = "Keep this explanation";
  const api = await fixture(page, doc);
  await page.goto("/sets/set/edit");
  await page
    .getByRole("button", { name: "03 Show steps", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove criterion 2", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Remove criterion 1", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add marking rubric" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Criterion 2", { exact: true })).toHaveValue(
    "Second step",
  );
  await page.getByRole("button", { name: "Remove item", exact: true }).click();
  await expect(
    page.getByText("Question removed.", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Question", { exact: true })
    .fill("Other edits survive");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Selected item")).toHaveText(/^3\./);
  await expect(page.getByLabel("Explanation (optional)")).toHaveValue(
    "Keep this explanation",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => api.set().revision).toBe(2);
  const saved = api.set().content;
  expect(saved.kind === "exam" && saved.questions[2]).toEqual(doc.questions[2]);
  expect(saved.kind === "exam" && saved.questions[1].prompt).toBe(
    "Other edits survive",
  );
});

test("card removal can be undone with unsaved front and back intact", async ({
  page,
}) => {
  await fixture(page, {
    schemaVersion: 1,
    kind: "flashcards",
    title: "Cards",
    cards: [
      { id: "a", front: "One", back: "First" },
      { id: "b", front: "Two", back: "Second" },
    ],
  });
  await page.goto("/sets/set/edit");
  await page.getByRole("button", { name: "Add card", exact: true }).click();
  await page.getByLabel("Front", { exact: true }).fill("Unsaved front");
  await page.getByLabel("Back", { exact: true }).fill("Unsaved back");
  await page.getByRole("button", { name: "Remove item", exact: true }).click();
  await expect(page.getByText("Card removed.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByLabel("Selected item")).toHaveText(/^3\./);
  await expect(page.getByLabel("Front", { exact: true })).toHaveValue(
    "Unsaved front",
  );
  await expect(page.getByLabel("Back", { exact: true })).toHaveValue(
    "Unsaved back",
  );
});

test("new editor validates visited fields and shows the full summary only after Save", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/new/exam/validation");
  await page.getByLabel("Title", { exact: true }).fill("New exam");
  await page.getByLabel("Description (optional)").focus();
  await expect(page.getByText(/items? needs? attention\./)).toHaveCount(0);
  await expect(page.getByLabel("Question", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await expect(page.getByLabel("Option A", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await page.getByLabel("Question", { exact: true }).focus();
  await page.getByLabel("Question", { exact: true }).press("Tab");
  await expect(page.getByLabel("Question", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("Option A", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "false",
  );
  await expect(
    page.getByRole("button", { name: "Next issue", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Next issue", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Option A", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
});

test("mobile editor starts near the question, keeps Save visible, and previews the true set count", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/sets/set/edit");
  await expect(page).toHaveTitle("Exam Prep");
  await expect(page.locator(".set-details")).not.toHaveAttribute("open", "");
  const prompt = page.getByLabel("Question", { exact: true });
  await expect(prompt).toBeVisible();
  expect((await prompt.boundingBox())!.y).toBeLessThan(700);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/examprep-ux-fixed-editor-mobile.png",
    animations: "disabled",
  });
  await page
    .getByLabel("Explanation (optional)")
    .fill("Explanation while scrolling");
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const save = page.getByRole("button", { name: "Save", exact: true });
  expect((await save.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect((await save.boundingBox())!.y).toBeLessThan(100);
  await page.setViewportSize({ width: 390, height: 420 });
  await page.getByLabel("Explanation (optional)").scrollIntoViewIfNeeded();
  expect((await save.boundingBox())!.y).toBeLessThan(100);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "02 Explain 2", exact: true }).click();
  await expect(page.locator(".content-preview")).toContainText(
    "Exam · 3 questions",
  );
  await expect(page.locator(".content-preview")).toContainText(
    "Preview of question 2 of 3",
  );
  await expect(page.locator(".content-preview")).toContainText("Explain 2");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/examprep-ux-fixed-editor-desktop.png",
    animations: "disabled",
  });
});

test("search empty states recover existing content and mobile History exposes Completed", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Reliable study", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search library").fill("no match");
  await expect(
    page.getByRole("heading", { name: "No study sets match this search." }),
  ).toBeVisible();
  await expect(
    page.getByText("Import a study set from a file.", { exact: false }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Reliable study", exact: true }),
  ).toBeVisible();
  await page.goto("/history");
  await page.getByLabel("Search history").fill("no match");
  await expect(
    page.getByRole("heading", { name: "No attempts match this search." }),
  ).toBeVisible();
  await expect(
    page.getByText("Your attempts will appear here when you start studying."),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Reliable study" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseOption(
    page.getByRole("combobox", { name: "Attempt status", exact: true }),
    "Completed",
  );
  await expect(
    page.getByRole("combobox", { name: "Attempt status", exact: true }),
  ).toHaveText("Completed");
  await expect(
    page.getByRole("heading", { name: "No attempts match these filters." }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/examprep-ux-fixed-history-mobile.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Reliable study" }),
  ).toBeVisible();
});

test("browse courses and organize one Library page at a time", async ({
  page,
}) => {
  const existing = await fixture(page);
  const sets = [
    { ...existing.set(), id: "other-page", title: "Cells", course: "Biology" },
    { ...existing.set(), id: "genetics", title: "Genetics", course: "Biology" },
    {
      ...existing.set(),
      id: "evolution",
      title: "Evolution",
      course: "Biology",
    },
    { ...existing.set(), id: "unsorted", title: "Field notes" },
  ];
  let failure = true;
  await page.route(
    /\/api\/sets(?:\?|\/courses|\/organization)/,
    async (route) => {
      const url = new URL(route.request().url());
      const archived = url.searchParams.get("archived") === "true";
      const scope = sets.filter((set) => set.archived === archived);
      if (url.pathname === "/api/sets/courses") {
        const courses = [...new Set(scope.map(({ course }) => course))];
        return route.fulfill({
          json: {
            items: courses.map((course) => ({
              course,
              count: scope.filter((set) => set.course === course).length,
            })),
            hasMore: false,
          },
        });
      }
      if (url.pathname === "/api/sets/organization") {
        const { ids, ...changes } = route.request().postDataJSON();
        expect(ids).toEqual(
          changes.archived ? ["genetics", "evolution"] : ["genetics"],
        );
        if (failure) {
          failure = false;
          return route.fulfill({
            status: 404,
            json: { error: "A selected set is unavailable." },
          });
        }
        for (const set of sets.filter((item) => ids.includes(item.id)))
          Object.assign(set, changes);
        return route.fulfill({ json: { updated: ids.length } });
      }
      const course = url.searchParams.get("course");
      const search = url.searchParams.get("search") ?? "";
      const kind = url.searchParams.get("kind");
      const page = Number(url.searchParams.get("page"));
      const items = scope.filter(
        (set) =>
          (course === null || set.course === course) &&
          (!kind || set.kind === kind) &&
          set.title.toLowerCase().includes(search.toLowerCase()),
      );
      return route.fulfill({
        json: {
          items: page ? items.slice(1) : items.slice(0, 1),
          hasMore: !page && items.length > 1,
          courses: ["Biology"],
          page,
        },
      });
    },
  );
  await page.goto("/?search=missing&kind=flashcards");
  await page.getByRole("button", { name: "By course" }).press("Enter");
  await expect(
    page.getByRole("button", { name: "No course 1 set" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Exam Prep");
  await page.screenshot({
    path: "/tmp/examprep-course-overview.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Biology 3 sets" }).press("Enter");
  await expect(page.getByRole("tabpanel")).toBeFocused();
  await expect(page.getByLabel("Search library")).toHaveValue("");
  await expect(
    page.getByRole("tab", { name: "All", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("link", { name: "Cells", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Select sets", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select this page" }).check();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Select sets", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select Genetics" }).press("Space");
  await expect(
    page.getByRole("checkbox", { name: "Select this page" }),
  ).toHaveJSProperty("indeterminate", true);
  await page
    .getByRole("button", { name: "Organize selected", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Organize selected sets" });
  await chooseOption(
    dialog.getByRole("combobox", { name: "Action" }),
    "Pin sets",
  );
  await dialog.getByRole("button", { name: "Apply to selected sets" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "A selected set is unavailable.",
  );
  await expect(dialog.getByText("1 set selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply to selected sets" }).click();
  await expect(page.getByText("1 set updated.", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Select sets", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select this page" }).check();
  await expect(
    page.getByRole("checkbox", { name: "Select Evolution" }),
  ).toBeChecked();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/tmp/examprep-bulk-library-mobile.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Organize selected", exact: true })
    .click();
  await chooseOption(
    dialog.getByRole("combobox", { name: "Action" }),
    "Archive sets",
  );
  await dialog.getByRole("button", { name: "Apply to selected sets" }).click();
  await expect(
    page.getByText("2 sets updated.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Cells", exact: true }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/page=/);

  await page.getByRole("button", { name: "By course" }).click();
  await expect(
    page.getByRole("button", { name: "Biology 1 set" }),
  ).toBeVisible();
  await chooseOption(
    page.getByRole("combobox", { name: "Show sets" }),
    "Archived",
  );
  await expect(
    page.getByRole("button", { name: "Biology 2 sets" }),
  ).toBeVisible();
});

test.describe("History organization", () => {
  test.use({ timezoneId: "America/New_York" });

  test("combines filters and restores an expanded group and its page from practice", async ({
    page,
  }) => {
    const existing = await fixture(page);
    const groups = [
      {
        setId: "set",
        title: "Renamed study set",
        count: 31,
        latestStartedAt: "2026-11-02T10:00:00.000Z",
      },
      {
        setId: null,
        title: null,
        count: 1,
        latestStartedAt: "2026-11-02T09:00:00.000Z",
      },
    ];
    const groupQueries: URLSearchParams[] = [];
    const attemptQueries: URLSearchParams[] = [];
    await page.route(/\/api\/attempts(?:\/groups)?\?/, async (route) => {
      const url = new URL(route.request().url());
      const query = url.searchParams;
      if (url.pathname.endsWith("/groups")) {
        groupQueries.push(query);
        return route.fulfill({ json: { items: groups, hasMore: false } });
      }
      attemptQueries.push(query);
      const laterPage = query.get("page") === "1";
      const deleted = query.get("unlinked") === "true";
      return route.fulfill({
        json: {
          items: [
            {
              ...existing.attempt(),
              title: deleted
                ? "Original deleted title"
                : laterPage
                  ? "Old study title"
                  : "More recent attempt",
              startedAt: deleted
                ? groups[1].latestStartedAt
                : groups[0].latestStartedAt,
              kind: "exam",
            },
          ],
          hasMore: !laterPage && !deleted,
        },
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      "/history?view=sets&type=exam&date=custom&from=2026-11-01&through=2026-11-02&status=in_progress&search=study",
    );
    const group = page.getByRole("button", {
      name: "Renamed study set 31 attempts",
    });
    await expect(group).toBeVisible();
    expect(Object.fromEntries(groupQueries.at(-1)!)).toMatchObject({
      status: "in_progress",
      type: "exam",
      search: "study",
      startedFrom: "2026-11-01T04:00:00.000Z",
      startedBefore: "2026-11-03T05:00:00.000Z",
    });
    await page.getByLabel("Start date").fill("2026-11-03");
    await expect(page.getByRole("alert")).toHaveText(
      "Start date must be on or before end date.",
    );
    await page.getByLabel("Start date").fill("2026-11-01");
    await group.press("Enter");
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await page
      .getByRole("navigation", { name: "Attempt pages for this group" })
      .getByRole("button", { name: "Next page" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Old study title" }),
    ).toBeVisible();
    expect(Object.fromEntries(attemptQueries.at(-1)!)).toMatchObject({
      page: "1",
      setId: "set",
      search: "study",
      type: "exam",
      status: "in_progress",
      startedFrom: "2026-11-01T04:00:00.000Z",
      startedBefore: "2026-11-03T05:00:00.000Z",
    });
    await page
      .getByRole("link", { name: "Resume practice", exact: false })
      .click();
    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(page).toHaveURL(/group=set&groupPage=1/);
    await expect(group).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("heading", { name: "Old study title" }),
    ).toBeVisible();

    const deleted = page.getByRole("button", {
      name: "Deleted sets 1 attempt",
    });
    await deleted.click();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("heading", { name: "Original deleted title" }),
    ).toBeVisible();
    expect(Object.fromEntries(attemptQueries.at(-1)!)).toMatchObject({
      page: "0",
      unlinked: "true",
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: "/tmp/examprep-history-groups-mobile.png",
      animations: "disabled",
    });
    await chooseOption(
      page.getByRole("combobox", { name: "Attempt type" }),
      "Spaced review",
    );
    await expect(deleted).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => groupQueries.at(-1)?.get("type")).toBe("spaced");
  });
});

test("sign-in resumes the requested page and preserves its filters", async ({
  page,
}) => {
  const api = await fixture(page);
  api.signedIn = false;
  const requested = "/history?status=in_progress&search=Reliable";
  await page.goto(requested);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("student@example.test");
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("sample-password");
  await password.press("Enter");
  await expect.poll(() => api.requests).toContain("/api/auth/sign-in/email");
  await expect(page).toHaveURL(requested);
  await expect(page).toHaveTitle("Exam Prep");
  await expect(page.getByLabel("Search history")).toHaveValue("Reliable");
  await expect(page.getByRole("tab", { name: "In progress" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("link", { name: "Resume practice" })).toBeVisible();
});

test("keyboard navigation opens menus and restores focus after dismissal", async ({
  page,
}) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const navigation = page.getByRole("button", { name: "Open navigation" });
  await navigation.press("Enter");
  const history = page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name: "History" });
  await history.press("Escape");
  await expect(navigation).toBeFocused();
  await expect(history).toHaveCount(0);
  await navigation.press("Enter");
  await page.getByLabel("Search library").click();
  await expect(history).toHaveCount(0);

  const create = page.locator("summary").filter({ hasText: "Create" });
  await create.press("ArrowUp");
  const ai = page.getByRole("button", { name: "Create with your AI" });
  await expect(ai).toBeFocused();
  await ai.press("Home");
  const exam = page.getByRole("link", { name: "Exam", exact: true });
  await expect(exam).toBeFocused();
  await exam.press("Escape");
  await expect(create).toBeFocused();
  await expect(ai).toBeHidden();

  await create.press("ArrowUp");
  await ai.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create with your AI" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect(create).toBeFocused();
});

test("Create options activate when Safari focuses the workspace on pointer down", async ({
  page,
}) => {
  await fixture(page);
  // Safari can focus the surrounding workspace when a link or button is pressed.
  await page.addInitScript(() => {
    document.addEventListener("mousedown", (event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".page-header .menu-content")
      ) {
        event.preventDefault();
        document.getElementById("main")?.focus({ preventScroll: true });
      }
    });
  });

  await page.goto("/");
  const create = page.locator("summary").filter({ hasText: "Create" });
  for (const { label, route, heading } of [
    { label: "Exam", route: /\/new\/exam\//, heading: "Questions" },
    { label: "Flashcards", route: /\/new\/flashcards\//, heading: "Cards" },
  ]) {
    await create.click();
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(route);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Library", exact: true }).click();
  }
  await create.click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Create with your AI" }),
  ).toBeVisible();
});

test("changing library pages returns focus to the new results", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/api\/sets\?/, (route) => {
    const pageIndex = Number(
      new URL(route.request().url()).searchParams.get("page"),
    );
    const items = Array.from({ length: pageIndex ? 1 : 30 }, (_, index) => ({
      ...api.set(),
      id: `set-${pageIndex}-${index}`,
      title: `Study set ${pageIndex * 30 + index + 1}`,
    }));
    return route.fulfill({
      json: { items, hasMore: !pageIndex, page: pageIndex, courses: [] },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Next page" }).press("Enter");
  await expect(
    page.getByRole("tabpanel", { name: "All study sets" }),
  ).toBeFocused();
  const firstSet = page.getByRole("link", { name: "Study set 31", exact: true });
  await expect(firstSet).toBeInViewport();
  await expect(page.getByText("Page 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).press("Enter");
  await expect(
    page.getByRole("link", { name: "Study set 1", exact: true }),
  ).toBeInViewport();
});

test("a temporary editor load failure can be retried in place", async ({
  page,
}) => {
  const api = await fixture(page);
  api.editorLoadFailures = 2;
  await page.goto("/sets/set/edit");
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  api.editorLoadFailures = 0;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByRole("heading", { name: written.title, level: 1 }),
  ).toBeVisible();
  await expect(page).toHaveURL("/sets/set/edit");
});

test("closing Import asks before discarding pasted work and Keep editing preserves it", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("tab", { name: "Paste JSON", exact: true }).click();
  const source = '{"unfinished":';
  await page.getByLabel("Study-set JSON").fill(source);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Discard your import draft?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Study-set JSON")).toHaveValue(source);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Discard your import draft?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Discard draft", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("tab", { name: "Paste JSON", exact: true }).click();
  await expect(page.getByLabel("Study-set JSON")).toHaveValue("");
});

for (const mode of ["unreviewed", "mistakes"] as const) {
  test(`flashcard results start a separate ${mode} subset`, async ({
    page,
  }) => {
    const doc: StudyContent = {
      schemaVersion: 1,
      kind: "flashcards",
      title: "Continue cards",
      cards: [
        { id: "one", front: "First?", back: "First answer" },
        { id: "two", front: "Second?", back: "Second answer" },
        { id: "three", front: "Third?", back: "Third answer" },
      ],
    };
    const api = await fixture(page, doc);
    api.attempt().responses = {
      one: {
        revealed: true,
        rating: mode === "unreviewed" ? "known" : "review_again",
      },
    };
    await page.goto("/practice/attempt");
    await page
      .getByRole("button", { name: "Finish session", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Finish session", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Session complete" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Study unreviewed cards (2)",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "No mistakes to retry", exact: true }),
    ).toHaveCount(0);
    if (mode === "unreviewed")
      await page.screenshot({
        path: "/tmp/examprep-ux-fixed-unreviewed-results.png",
        animations: "disabled",
      });
    await page
      .getByRole("button", {
        name:
          mode === "unreviewed"
            ? "Study unreviewed cards (2)"
            : "Review again (1)",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/practice\/fresh$/);
    expect(api.retries).toHaveLength(1);
    expect(api.retries[0].mode).toBe(mode);
    expect(api.retries[0].snapshot).toEqual({
      ...doc,
      cards: mode === "unreviewed" ? doc.cards.slice(1) : [doc.cards[0]],
    });
    await expect(
      page.getByRole("button", {
        name: mode === "unreviewed" ? "Card 1 of 2" : "Card 1 of 1",
        exact: true,
      }),
    ).toBeVisible();
    expect(api.attempt().status).toBe("completed");
  });
}

test("opens progress insights with separate scores and a next action", async ({
  page,
}) => {
  await fixture(page);
  const completedAt = "2026-11-08T14:00:00.000Z";
  await page.route("**/api/insights", (route) =>
    route.fulfill({
      json: {
        trends: [
          {
            setId: "set",
            title: "Biology",
            revision: 1,
            scores: [
              {
                id: "earlier",
                completedAt,
                result: {
                  automatic: { earnedPoints: 2, maxPoints: 4, pendingCount: 0 },
                  selfAssessed: {
                    earnedPoints: 1,
                    maxPoints: 3,
                    pendingCount: 0,
                  },
                },
              },
              {
                id: "attempt",
                completedAt,
                result: {
                  automatic: { earnedPoints: 4, maxPoints: 4, pendingCount: 0 },
                  selfAssessed: {
                    earnedPoints: 2,
                    maxPoints: 3,
                    pendingCount: 0,
                  },
                },
              },
            ],
          },
        ],
        pending: { attemptId: "attempt", sessions: 1, answers: 2 },
        recurring: [
          {
            attemptId: "attempt",
            itemId: "q1",
            setTitle: "Biology",
            prompt: "Explain mitosis.",
            misses: 2,
          },
        ],
        retry: null,
      },
    }),
  );
  await page.goto("/history");
  await page.getByText("Progress insights", { exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "Automatic", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Self-assessed", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "4 / 4", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "2 / 3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Explain mitosis." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue self-assessment" }),
  ).toHaveAttribute("href", "/practice/attempt");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/examprep-progress-insights-mobile.png",
    animations: "disabled",
  });
});

test("sets a deck's daily review limit and starts its due queue", async ({
  page,
}) => {
  const cards: StudyContent = {
    kind: "flashcards",
    schemaVersion: 1,
    title: "Spanish verbs",
    cards: [
      { id: "one", front: "hablar", back: "to speak" },
      { id: "two", front: "vivir", back: "to live" },
    ],
  };
  await fixture(page, cards);
  const queue = {
    title: cards.title,
    limit: 20,
    reviewedToday: 0,
    due: 1,
    available: 1,
    archived: false,
    resetsAt: "2026-11-10T00:00:00.000Z",
    activeAttemptId: null,
    cards: [
      { id: "one", front: "hablar", nextReviewAt: null, due: true },
      {
        id: "two",
        front: "vivir",
        nextReviewAt: "2026-11-12T12:00:00.000Z",
        due: false,
      },
    ],
  };
  await page.route("**/api/sets/set/review", (route) => {
    const method = route.request().method();
    if (method === "PATCH") {
      queue.limit = route.request().postDataJSON().limit;
    }
    return route.fulfill({
      json: method === "POST" ? { id: "attempt" } : queue,
    });
  });
  await page.goto("/");
  await page
    .locator("summary")
    .filter({ hasText: "Actions for Spanish verbs" })
    .click();
  await page.getByRole("link", { name: "Spaced review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Due queue" })).toBeVisible();
  await expect(page.getByText("Due now", { exact: true })).toBeVisible();
  await expect(
    page.locator('time[datetime="2026-11-12T12:00:00.000Z"]'),
  ).toBeVisible();
  await page.getByLabel("Daily review limit").fill("8");
  await page.getByRole("button", { name: "Save limit", exact: true }).click();
  await expect(
    page.getByText("0 of 8 reviewed today", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/examprep-due-review-desktop.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Review 1 card", exact: true })
    .click();
  await expect(page).toHaveURL(/\/practice\/attempt$/);
});
