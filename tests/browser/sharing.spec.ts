import { expect, test } from "@playwright/test";
import type { StudySet } from "../../client/lib/api";
import type { DirectorySet } from "../../shared/directory";
import type { ShareSettings } from "../../shared/sharing";

const token = "example-signed-token";
const source: StudySet = {
  id: "original",
  kind: "flashcards",
  title: "Shared vocabulary",
  content: {
    schemaVersion: 1,
    kind: "flashcards",
    title: "Shared vocabulary",
    cards: [{ id: "one", front: "uno", back: "one" }],
  },
  ownershipRole: "primary",
  revision: 1,
  updatedAt: "2026-11-13T00:00:00.000Z",
  course: "",
  archived: false,
  pinned: false,
  lastStudiedAt: null,
  count: 1,
};

test("browses Discover by title and format across result pages", async ({
  page,
}) => {
  const entries: DirectorySet[] = [
    {
      id: "exam",
      kind: "exam",
      title: "Vocabulary practice exam",
      ownerName: "Course tutor",
      count: 12,
    },
    {
      id: source.id,
      kind: source.kind,
      title: source.title,
      ownerName: "Original owner",
      count: 1,
    },
  ];
  let failRequest = true;
  await page.route("**/api/**", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    if (pathname === "/api/auth/get-session") {
      return route.fulfill({
        json: { user: { id: "reader", email: "reader@example.test" } },
      });
    }
    if (pathname === "/api/discover") {
      if (failRequest) {
        failRequest = false;
        return route.fulfill({
          status: 503,
          json: { error: "Directory temporarily unavailable" },
        });
      }
      const title = searchParams.get("q")?.toLowerCase() ?? "";
      const kind = searchParams.get("kind");
      const matches = entries.filter(
        (set) =>
          (!kind || kind === set.kind) &&
          set.title.toLowerCase().includes(title),
      );
      const start = searchParams.get("after") ? 1 : 0;
      return route.fulfill({
        json: {
          items: matches.slice(start, start + 1),
          next: matches[start + 1] ? matches[start].id : null,
        },
      });
    }
    if (pathname === "/api/discover/" + source.id) {
      return route.fulfill({
        json: { content: source.content, ownerName: "Original owner" },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected path" } });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/discover");
  await page.getByRole("button", { name: "Retry" }).click();
  const exam = page.getByRole("link", { name: entries[0].title });
  const deck = page.getByRole("link", { name: source.title });
  await expect(exam).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(deck).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Published sets" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(exam).toBeVisible();

  await page.getByRole("radio", { name: "All sets" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "Exams" })).toBeChecked();
  await expect(exam).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search published sets" });
  await search.fill("shared");
  await expect(
    page.getByRole("heading", { name: "No matching sets" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("radio", { name: "All sets" })).toBeChecked();

  const formats = page.getByRole("group", { name: "Browse by format" });
  await formats.getByText("Flashcards", { exact: true }).click();
  await search.fill("vocabulary");
  await expect(deck).toHaveAccessibleDescription(
    "Owned by Original owner Flashcards 1 card",
  );
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("radio", { name: "Flashcards" })).toBeChecked();
  await deck.click();
  await expect(page.getByRole("heading", { name: source.title })).toBeVisible();
});

test("manages a view-only link and pending co-owners from the library and editor", async ({
  page,
  context,
}) => {
  const settings: ShareSettings = { link: null, invitations: [], coOwners: [] };
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/auth/get-session")
      return route.fulfill({
        json: { user: { id: "primary", email: "owner@example.test" } },
      });
    if (path === "/api/library/context")
      return route.fulfill({
        json: { folders: [], invitations: [], suggestion: null },
      });
    if (path === "/api/sets")
      return route.fulfill({ json: { items: [source], courses: [], page: 0 } });
    if (path === "/api/sets/original") return route.fulfill({ json: source });
    if (path === "/api/sets/original/sharing/link")
      settings.link = req.postDataJSON().enabled ? `/share#${token}` : null;
    if (path === "/api/sets/original/sharing/invitations")
      settings.invitations = [
        { id: "invitation", email: req.postDataJSON().email },
      ];
    if (path === "/api/sets/original/sharing/invitations/invitation")
      settings.invitations = [];
    if (path.startsWith("/api/sets/original/sharing"))
      return route.fulfill({ json: settings });
    return route.fulfill({ status: 404, json: { error: "Unexpected path" } });
  });
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto("/library");
  await page
    .locator("summary")
    .filter({ hasText: "Actions for Shared vocabulary" })
    .click();
  await page.getByRole("button", { name: "Share and manage access" }).click();
  const dialog = page.getByRole("dialog", { name: "Share and manage access" });
  await dialog
    .getByRole("button", { name: "Copy view-only link", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/share#example-signed-token$/,
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator.clipboard, "writeText", {
      value: async () => {
        throw new Error("Clipboard unavailable");
      },
      configurable: true,
    }),
  );
  await dialog.getByRole("button", { name: "Copy view-only link" }).click();
  await expect(dialog.getByRole("status")).toContainText("Link selected");
  expect(
    await dialog
      .getByLabel("View-only link")
      .evaluate(
        (node: HTMLInputElement) =>
          node.selectionStart === 0 && node.selectionEnd === node.value.length,
      ),
  ).toBe(true);
  await dialog.getByText("Invite an editor", { exact: true }).click();
  await dialog.getByLabel("Editor email").fill("collaborator@example.test");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByText("Pending invitation")).toBeVisible();
  await dialog
    .getByRole("button", {
      name: "Cancel invitation for collaborator@example.test",
    })
    .click();
  await expect(dialog.getByText("Pending invitation")).toHaveCount(0);
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("link", { name: "Shared vocabulary" }).click();
  await page.getByRole("button", { name: "Share and manage access" }).click();
  await dialog.getByRole("button", { name: "Turn off link" }).click();
  await expect(
    dialog.getByRole("button", { name: "Copy view-only link" }),
  ).toBeVisible();
});

test("returns to the live reader after registering with a display name", async ({
  page,
}) => {
  let signedIn = false;

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    switch (new URL(req.url()).pathname) {
      case "/api/auth/get-session":
        return route.fulfill({
          json: signedIn
            ? { user: { id: "reader", email: "reader@example.test" } }
            : null,
        });
      case "/api/auth/sign-up/email":
        expect(req.postDataJSON().name).toBe("Reader");
        signedIn = true;
        return route.fulfill({ json: { success: true } });
      case "/api/shares/preview":
        expect(req.postDataJSON()).toEqual({ token });
        if (!signedIn) return route.fulfill({ json: { signInRequired: true } });
        return route.fulfill({
          json: { content: source.content, ownerName: "Original owner" },
        });
      default:
        return route.fulfill({
          status: 404,
          json: { error: "Unexpected path" },
        });
    }
  });
  await page.goto(`/share#${token}`);
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Display name").fill("  Reader  ");
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByLabel("Password", { exact: true }).fill("example-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/share#example-signed-token$/);
  await expect(page.getByRole("heading", { name: source.title })).toBeVisible();
  await expect(page.getByText("Owned by Original owner")).toBeVisible();
  await page.getByText("Show back").click();
  await expect(
    page.getByRole("button", { name: "Add to my library" }),
  ).toHaveCount(0);
});

test("accepts a pending invitation and shows the co-owned set without owner-only controls", async ({
  page,
}) => {
  let accepted = false;
  const coOwned = { ...source, ownershipRole: "co_owner" };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/get-session")
      return route.fulfill({
        json: { user: { id: "reader", email: "reader@example.test" } },
      });
    if (path === "/api/library/context")
      return route.fulfill({
        json: {
          folders: [],
          suggestion: null,
          invitations: accepted
            ? []
            : [
                {
                  id: "invitation",
                  title: source.title,
                  kind: source.kind,
                  ownerEmail: "owner@example.test",
                },
              ],
        },
      });
    if (path === "/api/ownership-invitations/invitation/respond") {
      expect(route.request().postDataJSON()).toEqual({ accept: true });
      accepted = true;
      return route.fulfill({ json: { accepted: true, studySetId: source.id } });
    }
    if (path === "/api/sets")
      return route.fulfill({
        json: { items: accepted ? [coOwned] : [], courses: [], page: 0 },
      });
    if (path === "/api/sets/original") return route.fulfill({ json: coOwned });
    return route.fulfill({ status: 404, json: { error: "Unexpected path" } });
  });
  await page.goto("/library");
  const invitations = page.getByRole("region", {
    name: "Ownership invitations",
  });
  await invitations.getByRole("button", { name: "Accept" }).click();
  await expect(invitations.getByRole("status")).toContainText("You now co-own");
  await expect(page.getByText("Co-owned", { exact: true })).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Actions for Shared vocabulary" })
    .click();
  await expect(
    page.getByRole("button", { name: "Make an independent copy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Share and manage access" }),
  ).toHaveCount(0);
});

test("guests can read immediately, save after sign-in, and see updates on return", async ({
  page,
}) => {
  let signedIn = false,
    saves = 0,
    title = source.title;
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const content = { ...source.content, title };
    if (path === "/api/auth/get-session")
      return route.fulfill({
        json: signedIn
          ? { user: { id: "learner", email: "learner@example.test" } }
          : null,
      });
    if (path === "/api/auth/sign-in/email") {
      signedIn = true;
      return route.fulfill({ json: { success: true } });
    }
    if (path === "/api/shares/preview")
      return route.fulfill({ json: { content, ownerName: "Tutor" } });
    if (path === "/api/shares/save") {
      expect(signedIn).toBe(true);
      expect(req.postDataJSON()).toEqual({ token });
      saves++;
      return route.fulfill({ json: { id: source.id } });
    }
    if (path === "/api/sets/original")
      return route.fulfill({
        json: {
          ...source,
          content,
          title,
          ownershipRole: "viewer",
          ownerName: "Tutor",
        },
      });
    return route.fulfill({ status: 404, json: { error: "Unexpected path" } });
  });
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto(`/share#${token}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  expect(saves).toBe(0);
  await page.getByRole("button", { name: "Save to my library" }).click();
  await page.getByLabel("Email", { exact: true }).fill("learner@example.test");
  await page.getByLabel("Password", { exact: true }).fill("valid-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/sets\/original\/view$/);
  expect(saves).toBe(1);
  title = "Owner’s revised vocabulary";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "Practice" }).click();
  await expect(
    page.getByRole("dialog", { name: "Set up practice" }),
  ).toBeVisible();
});
