import { chooseOption } from "./selector";
import { expect, test } from "@playwright/test";

test("previews a backup before restoring and saves study text size", async ({
  page,
}) => {
  const file = {
    schemaVersion: 1,
    kind: "exam-prep-library",
    backupId: "ccbb6ee7-6e0f-4316-b83d-8a065f26d78f",
    sets: [],
  };
  const history = {
    schemaVersion: 1,
    kind: "exam-prep-history",
    backupId: file.backupId,
    attempts: [],
    reviews: [],
  };
  const restoreRequests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/get-session")
      return route.fulfill({
        json: { user: { id: "backup-browser", email: "student@example.test" } },
      });
    if (path === "/api/backup")
      return route.fulfill({ json: { library: file, history } });
    if (path === "/api/backup/preview")
      return route.fulfill({
        json: {
          setCount: 1,
          attemptCount: 2,
          reviewCount: 0,
          titles: ["Calculus"],
        },
      });
    if (path === "/api/backup/restore") {
      restoreRequests.push(route.request().postData() ?? "");
      return route.fulfill({
        status: 201,
        json: { setCount: 1, attemptCount: 2, reviewCount: 0 },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected path." } });
  });
  await page.goto("/account");
  await expect(page).toHaveTitle("Exam Prep");
  await expect(
    page.getByRole("heading", { name: "Library backup" }),
  ).toBeVisible();
  await chooseOption(page.getByLabel("Study text size"), "Extra large");
  await page.reload();
  await expect(page.getByLabel("Study text size")).toHaveText("Extra large");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--study-scale"),
      ),
    )
    .toBe("1.5");

  await page
    .getByRole("checkbox", { name: "Prepare a separate practice history file" })
    .check();
  const [libraryDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download library backup" }).click(),
  ]);
  expect(libraryDownload.suggestedFilename()).toMatch(/^exam-prep-library-/);
  const [historyDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download practice history" }).click(),
  ]);
  expect(historyDownload.suggestedFilename()).toMatch(/^exam-prep-history-/);
  await page.getByLabel("Library backup file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await page.getByLabel("Practice history file (optional)").setInputFiles({
    name: "history.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(history)),
  });
  await page.getByRole("button", { name: "Preview restore" }).click();
  await expect(page.getByText("Calculus", { exact: true })).toBeVisible();
  expect(restoreRequests).toEqual([]);
  await page.getByRole("button", { name: "Restore backup" }).click();
  await expect(
    page.getByText("Restored 1 study set, 2 attempts, and 0 scheduled cards."),
  ).toBeVisible();
  expect(restoreRequests.map((body) => JSON.parse(body))).toEqual([
    { library: file, history },
  ]);
  expect(errors).toEqual([]);
});

test("requests a password reset and consumes a link", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const submitted: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/get-session")
      return route.fulfill({ body: "null", contentType: "application/json" });
    if (path === "/api/account/recovery")
      return route.fulfill({ json: { enabled: true } });
    if (
      path === "/api/auth/request-password-reset" ||
      path === "/api/auth/reset-password"
    ) {
      submitted.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: true } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected path." } });
  });
  await page.goto("/sign-in");
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(
    page.getByRole("heading", { name: "Forgot your password?" }),
  ).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill("student@example.test");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If there is an account",
  );
  await page.goto("/reset-password#token=example-reset-token");
  await page.getByLabel("New password").fill("New example password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("status")).toContainText("Password reset");
  expect(submitted).toEqual([
    { email: "student@example.test" },
    { token: "example-reset-token", newPassword: "New example password" },
  ]);
});

test("large study text keeps long content readable and scrollable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem("examprep-reading-size-v1:reader", "extra-large");
  });
  const longPrompt = [
    "Read this question and its example before choosing an answer.",
    "",
    "| Topic | Detail |",
    "| --- | --- |",
    "| Example | A readable table |",
    "",
    "```text",
    "a_long_line_".repeat(45),
    "```",
  ].join("\n");
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/get-session") {
      return route.fulfill({
        json: { user: { id: "reader", email: "reader@example.test" } },
      });
    }
    if (path === "/api/attempts/read") {
      return route.fulfill({
        json: {
          id: "read",
          snapshot: {
            schemaVersion: 1,
            kind: "exam",
            title: "Reading practice",
            questions: [
              {
                id: "q1",
                type: "single_choice",
                prompt: longPrompt,
                answer: "a",
                options: [
                  { id: "a", text: "First answer" },
                  { id: "b", text: "Second answer" },
                ],
              },
            ],
          },
          responses: {},
          result: null,
          status: "in_progress",
          position: 0,
          revision: 1,
          startedAt: "2026-11-09T10:00:00.000Z",
          studySetId: "set",
          sourceAttemptId: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected path." } });
  });
  await page.goto("/practice/read");
  const table = page.getByRole("region", { name: "Study table" });
  await expect(table.getByRole("table")).toBeVisible();
  await table.focus();
  await expect(table).toBeFocused();
  await page.keyboard.press("Tab");
  const code = page.locator(".study-prompt pre");
  await expect(code).toBeFocused();
  expect(
    await code.evaluate((element) => element.scrollWidth > element.clientWidth),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await expect(page.locator(".study-prompt .study-content")).toHaveCSS(
    "font-size",
    "30px",
  );
});
