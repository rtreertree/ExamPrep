import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import {
  parseContent,
  validateContent,
  type StudyContent,
} from "../../shared/content";
import { mergeResponses } from "../../shared/attempts";
import type { Attempt, StudySet } from "../../client/lib/api";

// Browser plugin not available: use the project's Playwright workflow.
// API fixtures isolate input/rendering/persistence behavior from live accounts.
test.use({ hasTouch: true });
test.setTimeout(45000);

const content: StudyContent = {
  schemaVersion: 1,
  kind: "exam",
  title: "Notation practice",
  questions: [
    {
      id: "math",
      type: "written",
      answerType: "math",
      prompt: "Differentiate $x^2$.",
      answer: "$2x$",
    },
    {
      id: "chem",
      type: "written",
      answerType: "chem",
      prompt: "Balance the reaction.",
      answer: "$\\ce{2H2 + O2 -> 2H2O}$",
    },
    {
      id: "legacy",
      type: "written",
      prompt: "Explain your reasoning.",
      answer: "A simple answer.",
    },
  ],
};
async function mockAPI(page: Page) {
  let saved: StudySet = {
    id: "notation",
    title: content.title,
    kind: "exam",
    content: structuredClone(content),
    revision: 1,
    updatedAt: new Date().toISOString(),
    course: "",
    pinned: false,
    archived: false,
    lastStudiedAt: null,
  };
  let attempt: Attempt = {
    id: "notation",
    snapshot: structuredClone(content),
    responses: {},
    result: null,
    status: "in_progress",
    position: 0,
    revision: 1,
    startedAt: new Date().toISOString(),
    studySetId: "notation",
    sourceAttemptId: null,
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown;
    if (path === "/api/auth/get-session")
      response = {
        user: { id: "notation-user", email: "notation@example.test" },
      };
    else if (path === "/api/sets/notation") {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        saved = {
          ...saved,
          content: validateContent(body.content),
          revision: saved.revision + 1,
        };
      }
      response = saved;
    } else if (path === "/api/attempts/notation/progress") {
      const body = route.request().postDataJSON();
      attempt = {
        ...attempt,
        position: body.position,
        responses: mergeResponses(attempt.responses, body.changes),
        revision: attempt.revision + 1,
      };
      response = attempt;
    } else if (path === "/api/attempts/notation") response = attempt;
    else throw new Error(`Unexpected API call: ${path}`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  return { saved: () => saved, attempt: () => attempt };
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
  }
}

test("notation keyboard edits, preserves prose, exports v1 types, and fits desktop and phones", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const external: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname !== "127.0.0.1")
      external.push(request.url());
  });
  const api = await mockAPI(page);
  await page.goto("/sets/notation/edit");
  await expect(page).toHaveTitle("Exam Prep");
  await expect(
    page.getByRole("heading", {
      name: "Notation practice",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Answer type", { exact: true })).toHaveValue(
    "math",
  );
  const answer = page.getByLabel("Reference answer", { exact: true });
  await answer.fill("Before $2x$ after 🦊");
  await answer.evaluate((node: HTMLTextAreaElement) =>
    node.setSelectionRange(9, 9),
  );
  await page
    .locator(".field")
    .filter({ has: answer })
    .getByRole("button", { name: "Math keyboard", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("math-field")).toBeVisible();
  await expect(dialog.getByLabel("LaTeX source", { exact: true })).toHaveValue(
    "2x",
  );
  await expect(dialog.locator(".ML__keyboard.is-visible")).toBeVisible();
  await dialog.getByLabel("LaTeX source", { exact: true }).fill("\\frac{1}{2}");
  await expect(dialog.locator(".katex .mfrac")).toBeVisible();
  await page.screenshot({
    path: "/tmp/examprep-notation-desktop.png",
    fullPage: false,
  });
  await dialog
    .getByRole("button", { name: "Insert formula", exact: true })
    .click();
  await expect(answer).toHaveValue("Before $\\frac{1}{2}$ after 🦊");
  await expect(answer).toBeFocused();

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 740 });
    await page.getByLabel("Selected item", { exact: true }).selectOption("1");
    await expect(page.getByLabel("Answer type", { exact: true })).toHaveValue(
      "chem",
    );
    const reference = page.getByLabel("Reference answer", { exact: true });
    await reference.fill("");
    await page
      .locator(".field")
      .filter({ has: reference })
      .getByRole("button", { name: "Chemistry keyboard", exact: true })
      .click();
    await expect(dialog.locator(".ML__keyboard.is-visible")).toBeVisible();
    await noOverflow(page);
    // All categories remain reachable by scrolling the phone's layout strip.
    for (const category of [1, 2, 3, 4, 5, 6, 7, 0]) {
      await dialog
        .locator(".MLK__layer.is-visible .MLK__toolbar > .left > div")
        .nth(category)
        .click();
      await expect(
        dialog.locator(".MLK__layer.is-visible .MLK__rows"),
      ).toBeVisible();
      await noOverflow(page);
    }
    // Real touch keys feed the visual field, not just the source textarea.
    await dialog.getByLabel("LaTeX source", { exact: true }).focus();
    const hydrogen = dialog
      .locator(".MLK__layer.is-visible .MLK__keycap")
      .filter({ hasText: /^H$/ })
      .first();
    expect((await hydrogen.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await hydrogen.tap();
    await expect(
      dialog.getByLabel("LaTeX source", { exact: true }),
    ).not.toHaveValue("");
    expect(
      (
        await dialog.getByLabel("LaTeX source", { exact: true }).inputValue()
      ).match(/H/g),
    ).toHaveLength(1);
    await expect(dialog.locator("math-field")).toBeFocused();
    await hydrogen.tap();
    await expect
      .poll(
        async () =>
          (
            await dialog
              .getByLabel("LaTeX source", { exact: true })
              .inputValue()
          ).match(/H/g)?.length ?? 0,
      )
      .toBe(2);
    await dialog
      .getByLabel("LaTeX source", { exact: true })
      .fill("\\ce{2H2 + O2 -> 2H2O}");
    await expect(dialog.locator(".math-warning")).toHaveCount(0);
    await expect(dialog.locator(".katex").first()).toBeVisible();
    await page.screenshot({
      path: `/tmp/examprep-notation-mobile-${width}.png`,
      fullPage: false,
      animations: "disabled",
    });
    await dialog.getByLabel("Display on its own line").check();
    await dialog
      .getByRole("button", { name: "Insert formula", exact: true })
      .click();
    await expect(reference).toHaveValue("$$\n\\ce{2H2 + O2 -> 2H2O}\n$$");
    await noOverflow(page);
  }
  await page.getByLabel("Answer type", { exact: true }).selectOption("simple");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  const exported = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await exported;
  const portable = parseContent(readFileSync((await download.path())!, "utf8"));
  expect(portable).toEqual(api.saved().content);
  expect(portable.schemaVersion).toBe(1);
  if (portable.kind !== "exam") throw new Error("Expected exam");
  expect(portable.questions[0]).toMatchObject({ answerType: "math" });
  expect(portable.questions[1]).toMatchObject({ answerType: "simple" });
  expect(Object.hasOwn(portable.questions[2], "answerType")).toBe(false);
  await page.reload();
  await page.getByLabel("Selected item", { exact: true }).selectOption("1");
  await expect(
    page.getByLabel("Reference answer", { exact: true }),
  ).toHaveValue("$$\n\\ce{2H2 + O2 -> 2H2O}\n$$");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("practice saves notation responses and leaves submitted answers read-only", async ({
  page,
}) => {
  const api = await mockAPI(page);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto("/practice/notation");
  await expect(page.getByLabel("Your answer", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Math keyboard", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("LaTeX source", { exact: true })
    .fill("\\int_0^1 x^2\\,dx = \\frac{1}{3}");
  await dialog
    .getByRole("button", { name: "Insert formula", exact: true })
    .click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  expect(api.attempt().responses.math.text).toBe(
    "$\\int_0^1 x^2\\,dx = \\frac{1}{3}$",
  );
  await page.getByText("Preview your answer", { exact: true }).click();
  await expect(page.locator(".answer-preview .katex")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    api.attempt().responses.math.text!,
  );
  const savedAnswer = api.attempt().responses.math.text!;
  await page
    .getByRole("button", { name: "Math keyboard", exact: true })
    .click();
  await dialog.getByLabel("LaTeX source", { exact: true }).fill("x");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveValue(
    savedAnswer,
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page
    .getByRole("button", { name: "Chemistry keyboard", exact: true })
    .click();
  await dialog.getByLabel("LaTeX source", { exact: true }).fill("\\ce{SO4^2-}");
  await dialog
    .getByRole("button", { name: "Insert formula", exact: true })
    .click();
  await expect(
    page.getByText("Saved to your account", { exact: true }),
  ).toBeVisible();
  await noOverflow(page);
  api.attempt().status = "reviewing";
  api.attempt().responses.math.selfAssessment = "correct";
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Your submitted answer" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your answer", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Chemistry keyboard", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".math-warning")).toHaveCount(0);
});
