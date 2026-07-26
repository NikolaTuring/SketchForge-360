import { expect, test } from "@playwright/test";
import { addShape, openEditor, selectAll } from "./helpers";

/**
 * The status bar.
 *
 * It replaced a toast that floated over the model. Two things are worth
 * asserting: the message still arrives, and the numbers next to it say what
 * unit they are in — a bare "25" is a different part in millimetres than in
 * centimetres, and that ambiguity is the reason the bar exists.
 */

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("names the unit at all times", async ({ page }) => {
  await expect(page.getByTestId("status-unit")).toContainText("mm");
});

test("reports the selection", async ({ page }) => {
  await expect(page.getByTestId("status-selection")).toContainText("Nothing selected");

  await addShape(page, "box");
  await expect(page.getByTestId("status-selection")).toContainText("1 selected");

  await addShape(page, "cylinder");
  await selectAll(page);
  await expect(page.getByTestId("status-selection")).toContainText("2 selected");
});

test("shows the selection's size with its unit", async ({ page }) => {
  await addShape(page, "box");
  const extent = page.getByTestId("status-extent");
  await expect(extent).toBeVisible();
  await expect(extent).toContainText("mm");
  await expect(extent).toContainText("×");
});

test("carries the notice that used to float over the model", async ({ page }) => {
  await addShape(page, "box");
  await page.keyboard.press("Control+d");

  await expect(page.getByTestId("status-notice")).toContainText("Duplicated");
});

test("counts hidden bodies, and stops once nothing is hidden", async ({ page }) => {
  const box = await addShape(page, "box");
  await expect(page.getByTestId("status-hidden")).toHaveCount(0);

  await page.getByTestId(`browser-visibility-${box.id}`).click();
  await expect(page.getByTestId("status-hidden")).toContainText("1 hidden");

  await page.getByTestId(`browser-visibility-${box.id}`).click();
  await expect(page.getByTestId("status-hidden")).toHaveCount(0);
});

test("follows the language switch", async ({ page }) => {
  await page.getByTestId("language-switch").selectOption("de");
  await expect(page.getByTestId("status-selection")).toContainText("Nichts ausgewählt");
  await expect(page.getByTestId("status-unit")).toContainText("Einheit");
});
