import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

test("the landing page renders during session lookup and opens the signed-in library", async ({
  page,
}) => {
  let completeSession: () => void = () => {};
  const sessionPending = new Promise<void>((resolve) => {
    completeSession = resolve;
  });
  await page.addInitScript(() => {
    sessionStorage.setItem("examprep:list-v1:student:/", "search=biology");
  });
  await page.route("**/api/auth/get-session", async (route) => {
    await sessionPending;
    await route.fulfill({
      json: { user: { id: "student", email: "student@example.test" } },
    });
  });
  await page.route("**/api/sets?**", (route) =>
    route.fulfill({
      json: { items: [], folders: [], page: 0, hasMore: false },
    }),
  );
  await page.route("**/api/library/context?**", (route) =>
    route.fulfill({ json: { folders: [], invitations: [], suggestion: null } }),
  );

  const landing = page.getByRole("heading", { name: "Study on your terms." });
  try {
    await page.goto("/");
    await expect(page).toHaveTitle("Exam Prep");
    await expect(landing).toBeVisible();
  } finally {
    completeSession();
  }

  const openLibrary = page
    .getByRole("region", { name: "Study on your terms." })
    .getByRole("link", { name: "Open library" });
  await expect(openLibrary).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(landing).toBeVisible();
  await openLibrary.click();
  await expect(page).toHaveURL("/library");
  await expect(
    page.getByRole("heading", { name: "Your library" }),
  ).toBeVisible();
  await expect(page.getByLabel("Search library")).toHaveValue("biology");
});

test("visitors can copy a self-contained flashcard prompt before signing in", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null }),
  );
  await page.goto("/");
  await page.getByRole("link", { name: "Get materials", exact: true }).click();
  await expect(page).toHaveURL(/#get-materials$/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "How to get study material" }),
  ).toBeInViewport();
  await page.setViewportSize({ width: 320, height: 844 });
  const generator = page.getByRole("region", { name: "Prompt generator" });
  const prompt = generator.getByLabel("Prompt to copy");
  await expect(prompt).toBeHidden();
  await expect(
    generator.getByRole("button", { name: "Copy prompt" }),
  ).toBeDisabled();
  await generator.getByLabel("Topic or source material").fill("Cell biology");
  await generator.getByText("Flashcards", { exact: true }).tap();
  await generator.getByLabel("Number of flashcards").fill("16");
  await generator.getByLabel("Language").fill("Thai");
  const difficulty = generator.getByRole("group", { name: "Difficulty" });
  await expect(
    difficulty.getByRole("radio", { name: "Match the level" }),
  ).toBeChecked();
  await difficulty.getByText("Extremely hard", { exact: true }).tap();
  await expect(
    difficulty.getByRole("radio", { name: "Extremely hard" }),
  ).toBeChecked();
  expect(
    await difficulty.evaluate(
      (group) => group.scrollWidth <= group.clientWidth,
    ),
  ).toBe(true);
  await difficulty.screenshot({
    path: "/tmp/examprep-ai-hardness-mobile.png",
    animations: "disabled",
  });
  await generator.getByText("More options", { exact: true }).tap();
  await generator
    .getByLabel("Extra instructions (optional)")
    .fill("Add examples");
  await expect(generator.getByLabel("Written-question rubrics")).toHaveCount(0);
  await generator.getByRole("button", { name: "Copy prompt" }).click();
  await expect(generator.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(
    "Level: University\nLanguage: Thai\nItems: exactly 16\nDifficulty: Extremely hard",
  );
  expect(copied).toContain("Make every flashcard cue extremely hard");
  expect(copied).toContain('"Cell biology"');
  expect(copied).toContain('"Add examples"');
  expect(copied).toContain("Each card contains only id, front, and back.");
  await generator.getByText("Preview prompt", { exact: true }).press("Enter");
  await expect(prompt).toHaveValue(copied);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/examprep-ai-public-mobile.png",
    animations: "disabled",
  });

  await page
    .getByText("Optional instructions and examples", { exact: true })
    .click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download SKILL.md" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("SKILL.md");

  await page.reload();
  await expect(generator.getByLabel("Topic or source material")).toHaveValue(
    "",
  );
  await expect(
    difficulty.getByRole("radio", { name: "Match the level" }),
  ).toBeChecked();

  await page
    .getByRole("link", { name: "write one in the Exam Prep editor" })
    .click();
  await expect(page).toHaveURL(/#editor-path$/);
  await page.getByRole("link", { name: "Sign in to use the editor" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});
