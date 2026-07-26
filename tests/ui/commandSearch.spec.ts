import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, openEditor, sceneState } from "./helpers";

/**
 * Type-ahead access to every command.
 *
 * A ribbon hides rarely used commands behind tabs; this is the way back to them,
 * and the way a beginner discovers what the application can do.
 */

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

async function openSearch(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-search-input")).toBeFocused();
}

test("opens with Ctrl+K and closes with Escape", async ({ page }) => {
  await openSearch(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-search-input")).toHaveCount(0);
});

test("opens from the ribbon button", async ({ page }) => {
  await page.getByTestId("command-search-open").click();
  await expect(page.getByTestId("command-search-input")).toBeFocused();
});

test("closing the search does not clear the selection", async ({ page }) => {
  const box = await addShape(page, "box");
  await openSearch(page);
  await page.keyboard.press("Escape");

  expect((await sceneState(page)).selectedIds).toEqual([box.id]);
});

test("runs a command from the keyboard alone", async ({ page }) => {
  await addShape(page, "box");
  await openSearch(page);

  await page.getByTestId("command-search-input").fill("duplicate");
  await expect(page.getByTestId("command-result-duplicate")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("command-search-input")).toHaveCount(0);
  await expectShapeCount(page, 2);
});

test("ranks the closest match first", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("command-search-input").fill("und");

  const first = page.getByTestId("command-search-results").getByRole("option").first();
  await expect(first).toHaveAttribute("id", "command-result-undo");
});

test("finds a command by its German label after switching language", async ({ page }) => {
  await page.getByTestId("language-switch").selectOption("de");
  await addShape(page, "box");
  await openSearch(page);

  // Typed without the umlaut, as it would be on a hurried keyboard.
  await page.getByTestId("command-search-input").fill("loschen");
  await expect(page.getByTestId("command-result-delete")).toBeVisible();

  await page.keyboard.press("Enter");
  await expectShapeCount(page, 0);
});

test("shows unavailable commands but refuses to run them", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("command-search-input").fill("group");

  const result = page.getByTestId("command-result-group");
  await expect(result).toBeVisible();
  await expect(result).toBeDisabled();

  // Enter on a disabled entry must do nothing at all, not close and silently fail.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("command-search-input")).toBeVisible();
  await expectShapeCount(page, 0);
});

test("reports when nothing matches", async ({ page }) => {
  await openSearch(page);
  await page.getByTestId("command-search-input").fill("zzzzzz");
  await expect(page.getByTestId("command-search-results")).toContainText("No matching command");
});
