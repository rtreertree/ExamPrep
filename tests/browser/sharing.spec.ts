import { expect, test } from "@playwright/test";
import type { StudySet } from "../../client/lib/api";
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

test("manages a copy link and pending co-owners from the library and editor", async ({
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
    if (path === "/api/ownership-invitations")
      return route.fulfill({ json: [] });
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
  await page.goto("/");
  await page
    .locator("summary")
    .filter({ hasText: "Actions for Shared vocabulary" })
    .click();
  await page.getByRole("button", { name: "Share and manage access" }).click();
  const dialog = page.getByRole("dialog", { name: "Share and manage access" });
  await dialog.getByRole("button", { name: "Enable copy link" }).click();
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Link copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /\/share#example-signed-token$/,
  );
  await dialog.getByLabel("Co-owner email").fill("collaborator@example.test");
  await dialog.getByRole("button", { name: "Invite co-owner" }).click();
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
    dialog.getByRole("button", { name: "Enable copy link" }),
  ).toBeVisible();
});

test("returns to the copy link after registration and retries with the same import request", async ({
  page,
}) => {
  let signedIn = false;
  const ids: string[] = [];
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
        signedIn = true;
        return route.fulfill({ json: { success: true } });
      case "/api/shares/preview":
        expect(req.postDataJSON()).toEqual({ token });
        return route.fulfill({
          json: { title: source.title, kind: source.kind, count: 1 },
        });
      case "/api/shares/import":
        expect(req.postDataJSON().token).toBe(token);
        ids.push(req.postDataJSON().requestId);
        return ids.length === 1
          ? route.abort()
          : route.fulfill({ json: { id: "copy" } });
      case "/api/sets/copy":
        return route.fulfill({ json: { ...source, id: "copy" } });
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
  await page.getByLabel("Email", { exact: true }).fill("reader@example.test");
  await page.getByLabel("Password", { exact: true }).fill("example-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/share#example-signed-token$/);
  await expect(page.getByRole("heading", { name: source.title })).toBeVisible();
  await expect(page.getByText("Flashcards · 1 card")).toBeVisible();
  await page.getByRole("button", { name: "Add to my library" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not reach the server",
  );
  await page.reload();
  await page.getByRole("button", { name: "Add to my library" }).click();
  await expect(page).toHaveURL(/\/sets\/copy\/edit$/);
  expect(ids[1]).toBe(ids[0]);
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
    if (path === "/api/ownership-invitations")
      return route.fulfill({
        json: accepted
          ? []
          : [
              {
                id: "invitation",
                title: source.title,
                kind: source.kind,
                ownerEmail: "owner@example.test",
              },
            ],
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
  await page.goto("/");
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
    page.getByRole("button", { name: "Duplicate set" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Share and manage access" }),
  ).toHaveCount(0);
});
