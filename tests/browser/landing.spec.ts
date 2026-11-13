import { chooseOption } from "./selector";
import { expect, test } from "@playwright/test";

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
  const generator = page.getByRole("region", { name: "Prompt generator" });
  const prompt = generator.getByLabel("Prompt to copy");
  await expect(prompt).toBeHidden();
  await expect(
    generator.getByRole("button", { name: "Copy prompt" }),
  ).toBeDisabled();
  await generator.getByLabel("Topic or source material").fill("Cell biology");
  await chooseOption(generator.getByLabel("Content type"), "Flashcards");
  await generator.getByLabel("Item count").fill("16");
  await generator.getByLabel("Language").fill("Thai");
  const customize = generator.getByText("Customize", { exact: true });
  await customize.press("Enter");
  await chooseOption(generator.getByLabel("Difficulty"), "Challenging");
  await generator
    .getByLabel("Extra instructions (optional)")
    .fill("Add examples");
  await expect(generator.getByLabel("Written-question rubrics")).toHaveCount(0);
  await generator.getByRole("button", { name: "Copy prompt" }).click();
  await expect(generator.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(
    "Level: University\nLanguage: Thai\nItems: exactly 16\nDifficulty: Challenging",
  );
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

  await page
    .getByRole("link", { name: "write one in the Exam Prep editor" })
    .click();
  await expect(page).toHaveURL(/#editor-path$/);
  await page.getByRole("link", { name: "Sign in to use the editor" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
});
