import { expect, type Locator } from "@playwright/test";

export async function chooseOption(control: Locator, name: string | RegExp) {
  await control.click();
  const listId = await control.getAttribute("aria-controls");
  const list = control
    .page()
    .getByRole("listbox")
    .and(control.page().locator(`[id="${listId}"]`));
  await list.getByRole("option", { name, exact: true }).click();
  await expect(control).toHaveText(name);
}
