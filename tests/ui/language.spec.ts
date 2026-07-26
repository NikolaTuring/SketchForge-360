import { expect, test } from "@playwright/test";
import { addShape, openEditor, sceneState, tool } from "./helpers";

/**
 * The interface speaks German and English. These tests check the switch itself
 * and, more importantly, that switching language never touches the model — a
 * translated label must not rename anything already in the project.
 */

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

async function switchTo(page: import("@playwright/test").Page, language: "de" | "en") {
  await page.getByTestId("language-switch").selectOption(language);
  await expect(page.getByTestId("language-switch")).toHaveValue(language);
}

test("translates the ribbon", async ({ page }) => {
  await expect(tool(page, "delete")).toHaveAttribute("aria-label", "Delete");
  await expect(page.getByTestId("tab-geometry")).toHaveText("Geometry");

  await switchTo(page, "de");
  await expect(tool(page, "delete")).toHaveAttribute("aria-label", "Löschen");
  await expect(page.getByTestId("tab-geometry")).toHaveText("Geometrie");

  await switchTo(page, "en");
  await expect(tool(page, "delete")).toHaveAttribute("aria-label", "Delete");
});

test("translates the shape menu", async ({ page }) => {
  await switchTo(page, "de");
  await page.getByTestId("add-shape").click();
  await expect(page.getByTestId("shape-menu-box")).toContainText("Quader");
  await expect(page.getByTestId("shape-menu-cylinder")).toContainText("Zylinder");
});

test("names a new object in the language it was created in", async ({ page }) => {
  await switchTo(page, "de");
  await page.getByTestId("add-shape").click();
  await page.getByTestId("shape-menu-box").click();

  await expect.poll(async () => (await sceneState(page)).shapes[0]?.name).toBe("Quader");

  // Switching back must not rename what already exists.
  await switchTo(page, "en");
  expect((await sceneState(page)).shapes[0].name).toBe("Quader");
});

test("remembers the choice across a reload", async ({ page }) => {
  await switchTo(page, "de");
  await page.reload();

  await expect(page.getByTestId("language-switch")).toHaveValue("de");
  await expect(page.getByTestId("tab-geometry")).toHaveText("Geometrie");
});

test("leaves the model untouched when the language changes", async ({ page }) => {
  await addShape(page, "cylinder");
  const before = await sceneState(page);

  await switchTo(page, "de");
  const after = await sceneState(page);

  expect(after.shapeCount).toBe(before.shapeCount);
  expect(after.shapes[0].id).toBe(before.shapes[0].id);
  expect(after.shapes[0].kind).toBe(before.shapes[0].kind);
});

test("translates status notices", async ({ page }) => {
  await switchTo(page, "de");
  await page.getByTestId("add-shape").click();
  await page.getByTestId("shape-menu-box").click();
  await expect.poll(async () => (await sceneState(page)).notice).toBe("Quader hinzugefügt");

  await tool(page, "delete").click();
  await expect.poll(async () => (await sceneState(page)).notice).toMatch(/gelöscht/i);
});

test("translates a notice raised from a keyboard action", async ({ page }) => {
  await addShape(page, "box");

  await switchTo(page, "de");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneState(page)).notice).toBe("Auswahl aufgehoben");

  await switchTo(page, "en");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneState(page)).notice).toBe("Selection cleared");
});

test("translates the export panel", async ({ page }) => {
  await switchTo(page, "de");
  await page.getByRole("button", { name: "Exportieren" }).click();

  const panel = page.getByRole("dialog", { name: "Export" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Dateiname");
  await expect(panel).toContainText("Netz für den 3D-Druck");
});

test("sets the document language for assistive technology", async ({ page }) => {
  await switchTo(page, "de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");

  await switchTo(page, "en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
