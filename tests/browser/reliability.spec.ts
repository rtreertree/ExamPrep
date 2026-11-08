import { test, expect, type Page } from "@playwright/test";
import { grade, validateProgressChanges } from "../../shared/attempts";
import { validateContent, type StudyContent } from "../../shared/content";
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
    updatedAt: now,
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
    sourceAttemptId: null,
  };
  const state = {
    signedIn: true,
    userId: "student-a",
    signouts: 0,
    starts: 0,
    submitFailures: 0,
    logoutFailures: 0,
    delay: undefined as (() => Promise<void>) | undefined,
    set: () => set,
    attempt: () => attempt,
    requests: [] as string[],
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
      } else
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
                    }
                  : null,
            },
          ],
          hasMore: false,
        };
    } else if (path === "/api/sets/set") {
      if (req.method() === "PUT") {
        const content = validateContent(req.postDataJSON().content);
        set = {
          ...set,
          content,
          title: content.title,
          revision: set.revision + 1,
        };
      }
      value = set;
    } else if (path === "/api/sets/set/attempts") {
      state.starts++;
      value = { ...attempt, id: "fresh" };
    } else if (path === "/api/attempts")
      value = { items: [{ ...attempt, title: doc.title }], hasMore: false };
    else if (path === "/api/attempts/attempt") value = attempt;
    else if (path === "/api/attempts/fresh")
      value = { ...attempt, id: "fresh", snapshot: set.content };
    else if (path === "/api/attempts/attempt/progress") {
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
        .getByRole("button", { name: "2 · Unanswered", exact: true })
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
      page.getByRole("button", { name: `Question ${target + 1} of 3` }),
    ).toBeVisible();
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
    page.getByText("You are signed out. Some drafts", { exact: false }),
  ).toBeVisible();
  expect(api.signouts).toBe(2);
  expect(api.signedIn).toBe(false);
});
test("submission failure retains context; guided assessment commits partial rubrics and explicit zeros", async ({
  page,
}) => {
  const api = await fixture(page, mixed);
  api.attempt().responses = {
    binary: { text: "My reasoning" },
    rubric: { text: "My steps" },
  };
  api.submitFailures = 1;
  await page.goto("/practice/attempt");
  await page.getByRole("button", { name: "Submit exam", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("2 answered, 2 unanswered");
  await dialog.getByText("Review unanswered questions").click();
  await expect(
    dialog.getByRole("button", { name: "Question 4", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Submit and review answers" })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Submission failed");
  expect(api.attempt().status).toBe("in_progress");
  await dialog
    .getByRole("button", { name: "Submit and review answers" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Finish self-assessment" }),
  ).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Question 2 of 4" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    "My reasoning",
  );
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
  await one.fill("0");
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
  hold.release();
  await expect(
    page.getByRole("heading", { name: "Exam results" }),
  ).toBeFocused();
  expect(api.attempt().status).toBe("completed");
  expect(api.attempt().result?.selfAssessed).toEqual({
    earnedPoints: 1,
    maxPoints: 5,
    pendingCount: 0,
  });
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
  await page.getByLabel("Preview item").selectOption("499");
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
    page.getByRole("heading", { name: "1. Download the instructions" }),
  ).toBeVisible();
  await page
    .getByLabel("Topic or source material")
    .fill("Private student A notes");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await expect(page.getByLabel("Topic or source material")).toHaveValue(
    "Private student A notes",
  );
  api.userId = "student-b";
  await page.reload();
  await page.getByText("Create", { exact: true }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await expect(page.getByLabel("Topic or source material")).toHaveValue("");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByLabel("Search library").fill("beyond page one");
  await expect
    .poll(() =>
      api.requests.some((p) => p.includes("search=beyond%20page%20one")),
    )
    .toBe(true);
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
  await page
    .getByRole("button", { name: "Restore draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Question 2, question: Enter some text.",
  );
  await page.getByRole("button", { name: "Next issue", exact: true }).click();
  await expect(page.getByLabel("Selected item", { exact: true })).toHaveValue(
    "1",
  );
  await expect(page.getByLabel("Question", { exact: true })).toBeFocused();
  await page.getByLabel("Question", { exact: true }).fill("Repaired prompt");
  await page
    .getByRole("button", { name: "Save and practice", exact: true })
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
  await page.getByLabel("Topic or source material").fill("Keep my work");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByText("Your notes have not been saved on this device.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep my notes open" }).click();
  await expect(page.getByLabel("Topic or source material")).toHaveValue(
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
