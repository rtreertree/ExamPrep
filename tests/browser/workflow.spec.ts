import "dotenv/config";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connectDatabase } from "../../server/db";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
const email = `browser-${randomUUID()}@example.test`;
const password = randomUUID() + "aB9!";
const exam = readFileSync(
  "public/downloads/example-exam.examprep.json",
  "utf8",
);
const deck = readFileSync(
  "public/downloads/example-flashcards.examprep.json",
  "utf8",
);
async function apiRequest(
  request: APIRequestContext,
  path: string,
  method: string,
  data?: unknown,
) {
  const options = {
    method,
    headers: { Origin: process.env.TEST_BASE_URL || "http://127.0.0.1:8787" },
    data,
  };
  let response = await request.fetch("/api" + path, options);
  if (response.status() === 429) {
    const seconds = Number(response.headers()["x-retry-after"] || 60);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(seconds, 60) * 1000 + 100),
    );
    response = await request.fetch("/api" + path, options);
  }
  return response;
}
test.afterAll(async () => {
  const db = connectDatabase(process.env.DATABASE_URL!);
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});
test("complete study workflow, recovery, partial credit, flashcards, responsive layouts and keyboard", async ({
  page,
  context,
}) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Exam Prep");
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  let registrationResponse = page.waitForResponse((r) =>
    r.url().endsWith("/api/auth/sign-up/email"),
  );
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  const registration = await registrationResponse;
  const throttled = registration.status() === 429;
  if (throttled) {
    const seconds = Number(registration.headers()["x-retry-after"] || 60);
    await page.waitForTimeout(Math.min(seconds, 60) * 1000 + 100);
    registrationResponse = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/sign-up/email"),
    );
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    expect((await registrationResponse).ok()).toBeTruthy();
  }
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByRole("tab", { name: "Paste JSON" }).click();
  await page.getByLabel("Study-set JSON").fill("{bad}");
  await page.getByRole("button", { name: "Validate and preview" }).click();
  await expect(page.getByRole("alert")).toContainText("line 1");
  await page.getByLabel("Study-set JSON").fill(exam);
  await page.getByRole("button", { name: "Validate and preview" }).click();
  await expect(page.locator(".katex").first()).toBeVisible();
  await page.getByRole("button", { name: "Save to library" }).click();
  await expect(
    page.getByRole("link", { name: "Calculus practice", exact: true }),
  ).toBeVisible();
  // Create an invalid local draft and verify explicit recovery after a refresh.
  await page
    .getByRole("link", { name: "Calculus practice", exact: true })
    .click();
  await page
    .getByLabel("Title", { exact: true })
    .fill("Calculus practice — local draft");
  await expect(
    page.getByText("Draft saved on this device", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Restore draft" }),
  ).toBeVisible();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Calculus practice",
  );
  await page.getByRole("button", { name: "Restore draft" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Calculus practice — local draft",
  );
  await page.getByLabel("Title", { exact: true }).fill("Calculus practice");
  // Round-trip editing keeps stable IDs. Capture editor on the rubric question.
  await page.getByRole("button", { name: /02.*Differentiate/ }).click();
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 540 : 1024 });
    await page.getByRole("tab", { name: "Preview", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("tab", { name: "Edit", exact: true }).click();
    await page.getByLabel("Reference answer", { exact: true }).focus();
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.screenshot({ path: "/tmp/examprep-editor.png", fullPage: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "← Library", exact: true }).click();
  // External AI handoff is local and its downloaded fixtures are valid.
  await page.locator("summary").filter({ hasText: "Create" }).click();
  await page
    .getByRole("button", { name: "Create with your AI", exact: true })
    .click();
  await page.getByLabel("Topic or source material").fill("Calculus");
  await expect(page.getByLabel("Prompt to copy")).toHaveValue(
    /Topic: Calculus/,
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Topic: Calculus",
  );
  await expect(
    page.getByRole("link", { name: "Download required instructions" }),
  ).toHaveAttribute("href", "/downloads/SKILL.md");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.screenshot({ path: "/tmp/examprep-library.png" });
  await page.getByRole("button", { name: /Practice/ }).click();
  await page
    .getByRole("dialog", { name: "Set up practice" })
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await page.locator("input[type=radio][value=b]").check();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/examprep-exam.png" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 540 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.reload();
  await expect(page.locator("input[type=radio][value=b]")).toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByLabel("Your answer", { exact: true })
    .fill("Use the power rule with n=3.");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Your answer", { exact: true }).fill("Zero");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit exam", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Submit and review answers", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Finish self-assessment" }),
  ).toBeVisible();
  await page.getByLabel("Points for criterion 1 (maximum 2)").fill("1");
  await page.getByLabel("Points for criterion 1 (maximum 2)").press("Tab");
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Points for criterion 2 (maximum 3)").fill("2");
  await expect(
    page.getByRole("heading", { name: "Finish self-assessment" }),
  ).toBeVisible();
  await page.getByLabel("Points for criterion 2 (maximum 3)").press("Tab");
  await page.getByRole("button", { name: "Next unassessed answer" }).click();
  await page
    .getByRole("button", { name: "Correct · 1 point", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Exam results", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText("3 / 5 points · self-assessed")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry mistakes (1)" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/examprep-results.png", fullPage: true });
  await page.getByRole("button", { name: "Retry mistakes (1)" }).click();
  await expect(
    page.getByRole("button", { name: "Question 1 of 1" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue("");
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.getByLabel("Choose a JSON file").setInputFiles({
    name: "deck.examprep.json",
    mimeType: "application/json",
    buffer: Buffer.from(deck),
  });
  await page.getByRole("button", { name: "Save to library" }).click();
  await page
    .locator(".set-row")
    .filter({ hasText: "Derivative rules" })
    .getByRole("button", { name: /Practice/ })
    .click();
  await page
    .getByRole("dialog", { name: "Set up practice" })
    .getByRole("button", { name: "Start practice", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Known", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Reveal answer" }).click();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Known", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/examprep-flashcard.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Review again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Card 2 of 2" })).toBeVisible();
  await page.getByRole("button", { name: "Reveal answer" }).click();
  await page.getByRole("button", { name: "Known", exact: true }).click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
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
    page.getByRole("button", { name: "Review again (1)" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  // Use real content while checking all documented responsive widths.
  for (const width of [1536, 1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 1024 });
    await expect(
      page.getByRole("heading", { name: "Your library" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".set-row")).toHaveCount(2);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `/tmp/examprep-library-${width}.png`,
      animations: "disabled",
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".workspace-main")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  await page.getByRole("tab", { name: "All", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Exams", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("tab", { name: "Exams", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Import", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".attempt-row")).toHaveCount(3);
  await page
    .locator(".attempt-row")
    .filter({ hasText: "In progress" })
    .getByRole("link", { name: /Resume/ })
    .click();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue("");
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page
    .locator(".attempt-row")
    .filter({ hasText: "Calculus practice" })
    .filter({ hasText: "Completed" })
    .getByRole("link", { name: /Review/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Exam results", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Submit exam", exact: true }),
  ).toHaveCount(0);
  expect(
    consoleErrors.filter((message) => !(throttled && message.includes("429"))),
  ).toEqual([]);
});

test("server conflicts preserve editor work; save failures retain practice input; new drafts recover and stay account-scoped", async ({
  page,
  context,
}) => {
  const extraEmail = `browser-recovery-${randomUUID()}@example.test`;
  const request = async (path: string, method: string, data?: unknown) => {
    const response = await apiRequest(context.request, path, method, data);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  try {
    await page.goto("/sign-in");
    await request("/auth/sign-up/email", "POST", {
      email: extraEmail,
      password,
      name: "Recovery test",
    });
    await page.reload();
    const saved = await request("/sets", "POST", JSON.parse(exam));
    await page.goto(`/sets/${saved.id}/edit`);
    await page.getByLabel("Title", { exact: true }).fill("My preserved edits");
    await expect(
      page.getByText("Draft saved on this device", { exact: true }),
    ).toBeVisible();
    await request(`/sets/${saved.id}`, "PUT", {
      revision: 1,
      content: { ...JSON.parse(exam), title: "Changed on another device" },
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Save as new set" }),
    ).toBeVisible();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
      "My preserved edits",
    );
    await page.getByRole("button", { name: "Save as new set" }).click();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    const copiedId = page.url().split("/sets/")[1].split("/")[0];
    const attempt = await request(`/sets/${copiedId}/attempts`, "POST", {});
    await page.goto(`/practice/${attempt.id}`);
    await page.route("**/api/attempts/*/progress", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Injected save failure"}',
      }),
    );
    await page.locator("input[type=radio][value=b]").check();
    await expect(page.getByRole("alert")).toContainText(
      "Injected save failure",
    );
    await expect(page.locator("input[type=radio][value=b]")).toBeChecked();
    await page.unroute("**/api/attempts/*/progress");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    await page.route("**/api/attempts/*/progress", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":"Session expired"}',
      }),
    );
    await page.locator("input[type=radio][value=a]").check();
    await expect(
      page.getByRole("dialog", { name: "Your session has expired" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Return to my changes" }).click();
    await expect(page.locator("input[type=radio][value=a]")).toBeChecked();
    await page.unroute("**/api/attempts/*/progress");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Library", exact: true }).click();
    await page.locator("summary").filter({ hasText: "Create" }).click();
    await page.getByRole("link", { name: "Exam", exact: true }).click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Incomplete new draft");
    await expect(
      page.getByText("Draft saved on this device", { exact: true }),
    ).toBeVisible();
    const draftUrl = page.url();
    await page.reload();
    await page.getByRole("button", { name: "Restore draft" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
      "Incomplete new draft",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Must contain text");
    // Expire browser cookies without explicit logout. The first account's local draft remains private.
    await context.clearCookies();
    await page.goto("/sign-in");
    const separate = await context.browser()!.newContext({
      baseURL: process.env.TEST_BASE_URL || "http://127.0.0.1:8787",
    });
    const otherEmail = `browser-other-${randomUUID()}@example.test`;
    const response = await apiRequest(
      separate.request,
      "/auth/sign-up/email",
      "POST",
      { email: otherEmail, password, name: "Other" },
    );
    expect(response.ok()).toBeTruthy();
    try {
      await context.addCookies(await separate.cookies());
      await page.goto("/");
      await expect(
        page.getByText("Incomplete new draft", { exact: true }),
      ).toHaveCount(0);
      await page.goto(draftUrl);
      await expect(
        page.getByRole("button", { name: "Restore draft" }),
      ).toHaveCount(0);
    } finally {
      const db = connectDatabase(process.env.DATABASE_URL!);
      await db.user.deleteMany({ where: { email: otherEmail } });
      await db.$disconnect();
      await separate.close();
    }
    await context.clearCookies();
    await request("/auth/sign-in/email", "POST", {
      email: extraEmail,
      password,
    });
    await page.goto(draftUrl);
    await expect(
      page.getByRole("button", { name: "Restore draft" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
    // Author both content kinds using the reusable form, including a reordered rubric question.
    await page
      .getByLabel("Title", { exact: true })
      .fill("Manually authored exam");
    await page.getByLabel("Question", { exact: true }).fill("What is $2+2$?");
    await page.getByLabel("Option A", { exact: true }).fill("3");
    await page.getByLabel("Option B", { exact: true }).fill("4");
    await page.getByLabel("Correct answer", { exact: true }).selectOption("b");
    await page
      .getByRole("button", { name: "Written answer", exact: true })
      .click();
    await page
      .getByLabel("Question", { exact: true })
      .fill("Explain the addition.");
    await page
      .getByLabel("Reference answer", { exact: true })
      .fill("Two plus two equals four.");
    await page
      .getByRole("button", { name: "Add marking rubric", exact: true })
      .click();
    await page
      .getByLabel("Criterion 1", { exact: true })
      .fill("Show the addition");
    await page.getByLabel("Maximum points", { exact: true }).fill("2");
    await page
      .getByRole("button", { name: "Add criterion", exact: true })
      .click();
    await page
      .getByLabel("Criterion 2", { exact: true })
      .fill("State the result");
    await page.getByLabel("Maximum points", { exact: true }).nth(1).fill("3");
    await page
      .getByRole("button", { name: "Move item up", exact: true })
      .click();
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const exportedFile = await downloading;
    const portable = JSON.parse(
      readFileSync((await exportedFile.path())!, "utf8"),
    );
    expect(portable.questions[0].type).toBe("written");
    expect(
      portable.questions[0].rubric.map((c: { points: number }) => c.points),
    ).toEqual([2, 3]);
    expect(portable.questions[1].answer).toBe("b");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    const manualId = page.url().split("/sets/")[1].split("/")[0];
    const persisted = await request(`/sets/${manualId}`, "GET");
    expect(persisted.content).toEqual(portable);
    await page.goto(`/new/flashcards/${randomUUID()}`);
    await page
      .getByLabel("Title", { exact: true })
      .fill("Manually authored cards");
    await page.getByLabel("Front", { exact: true }).fill("What is $1+1$?");
    await page.getByLabel("Back", { exact: true }).fill("$2$");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Account", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page
      .getByRole("button", { name: "Sign out and clear drafts" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Welcome back" }),
    ).toBeVisible();
  } finally {
    const db = connectDatabase(process.env.DATABASE_URL!);
    await db.user.deleteMany({ where: { email: extraEmail } });
    await db.$disconnect();
  }
});

test("multi-digit rubric awards commit on blur; invalid math warns and long formulas stay within their region", async ({
  page,
  context,
}) => {
  const accountEmail = `browser-math-${randomUUID()}@example.test`;
  try {
    await page.goto("/sign-in");
    expect(
      (
        await apiRequest(context.request, "/auth/sign-up/email", "POST", {
          email: accountEmail,
          password,
          name: "Math test",
        })
      ).ok(),
    ).toBeTruthy();
    const content = {
      schemaVersion: 1,
      kind: "exam",
      title: "Formula and scoring checks",
      questions: [
        {
          id: "__proto__",
          type: "written",
          prompt:
            "Find $\\frac{1}{$.\n\n$" +
            "x+".repeat(120) +
            "x$\n\n$$\n" +
            "y+".repeat(240) +
            "y\n$$",
          answer: "Reference",
          rubric: [
            { id: "__proto__", description: "Show working", points: 20 },
          ],
        },
      ],
    };
    const set = await (
      await apiRequest(context.request, "/sets", "POST", content)
    ).json();
    const attempt = await (
      await apiRequest(context.request, `/sets/${set.id}/attempts`, "POST", {})
    ).json();
    await page.goto(`/practice/${attempt.id}`);
    await page.getByLabel("Your answer", { exact: true }).fill("My working");
    await expect(
      page.getByText("Saved to your account", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Submit exam", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Submit and review answers", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Finish self-assessment" }),
    ).toBeVisible();
    await expect(page.locator(".math-warning")).toBeVisible();
    await page.setViewportSize({ width: 320, height: 540 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page
        .locator(".katex-display")
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    const points = page.getByLabel("Points for criterion 1 (maximum 20)");
    await points.pressSequentially("10", { delay: 100 });
    await page.waitForTimeout(700);
    await expect(points).toHaveValue("10");
    await expect(
      page.getByRole("heading", { name: "Finish self-assessment" }),
    ).toBeVisible();
    await points.press("Tab");
    await expect(
      page.getByRole("heading", { name: "Exam results", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("10 / 20 points · self-assessed"),
    ).toBeVisible();
    await expect(page.locator(".score-group")).toHaveCount(1);
    await page.goto(`/new/exam/${randomUUID()}`);
    await page.evaluate(() => {
      indexedDB.open = () => {
        throw new DOMException(
          "Injected storage failure",
          "QuotaExceededError",
        );
      };
    });
    await page
      .getByLabel("Title", { exact: true })
      .fill("Unsaved device draft");
    await expect(page.getByRole("alert")).toContainText(
      "Device storage is unavailable",
    );
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
      "Unsaved device draft",
    );
  } finally {
    const db = connectDatabase(process.env.DATABASE_URL!);
    await db.user.deleteMany({ where: { email: accountEmail } });
    await db.$disconnect();
  }
});
