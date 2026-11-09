import { expect, test } from "@playwright/test";

test("visitors can download authoring instructions and copy a tailored prompt before signing in", async ({
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
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download SKILL.md" }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("SKILL.md");

  const generator = page.getByRole("region", { name: "Prompt generator" });
  const prompt = generator.getByLabel("Prompt to copy");
  await expect(prompt).toHaveValue(/Type: exam/);
  await generator.getByLabel("Topic or source material").fill("Cell biology");
  await generator.getByLabel("Content type").selectOption("flashcards");
  await generator.getByLabel("Item count").fill("16");
  await generator.getByLabel("Language").fill("Thai");
  await expect(prompt).toHaveValue(
    /Topic: Cell biology\nLevel: University\nLanguage: Thai\nItems: 16\nType: flashcards/,
  );
  await generator.getByRole("button", { name: "Copy prompt" }).click();
  await expect(generator.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await prompt.inputValue(),
  );

  await page
    .getByRole("link", { name: "write one in the Exam Prep editor" })
    .click();
  await expect(page).toHaveURL(/#editor-path$/);
  await page.getByRole("link", { name: "Sign in to use the editor" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});
