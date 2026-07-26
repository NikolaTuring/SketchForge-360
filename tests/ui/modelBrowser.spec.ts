import { expect, test } from "@playwright/test";
import { addShape, openEditor, sceneState, tool } from "./helpers";

/**
 * The model browser.
 *
 * Its reason for existing is the hidden body: once something is invisible, the
 * viewport can no longer reach it, and before the browser the only way back was
 * a command that unhid *everything*. Most of what is checked here is that
 * hidden and locked bodies stay listed, stay named, and stay operable.
 */

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("lists a body as soon as it exists", async ({ page }) => {
  await expect(page.getByTestId("browser-empty")).toBeVisible();

  const box = await addShape(page, "box");
  await expect(page.getByTestId(`browser-row-${box.id}`)).toBeVisible();
  await expect(page.getByTestId(`browser-name-${box.id}`)).toHaveText(box.name);
});

test("selection runs both ways", async ({ page }) => {
  const box = await addShape(page, "box");
  const cylinder = await addShape(page, "cylinder");

  // Scene to browser: adding a shape selects it, and the browser shows that.
  await expect(page.getByTestId(`browser-row-${cylinder.id}`)).toHaveClass(/selected/);

  // Browser to scene.
  await page.getByTestId(`browser-name-${box.id}`).click();
  expect((await sceneState(page)).selectedIds).toEqual([box.id]);

  await page.getByTestId(`browser-name-${cylinder.id}`).click({ modifiers: ["Control"] });
  expect((await sceneState(page)).selectedIds.sort()).toEqual([box.id, cylinder.id].sort());
});

test("a hidden body stays listed and can be brought back", async ({ page }) => {
  const box = await addShape(page, "box");
  const row = page.getByTestId(`browser-row-${box.id}`);

  await page.getByTestId(`browser-visibility-${box.id}`).click();
  await expect(row).toHaveClass(/hidden-body/);
  await expect(row).toBeVisible();

  await page.getByTestId(`browser-visibility-${box.id}`).click();
  await expect(row).not.toHaveClass(/hidden-body/);
});

test("locking a body from the browser stops it being deleted", async ({ page }) => {
  const box = await addShape(page, "box");
  await page.getByTestId(`browser-lock-${box.id}`).click();

  await page.getByTestId(`browser-name-${box.id}`).click();
  await page.keyboard.press("Delete");

  // The lock is the point: a locked body survives a delete aimed straight at it.
  await expect(page.getByTestId(`browser-row-${box.id}`)).toBeVisible();
  expect((await sceneState(page)).shapeCount).toBe(1);
});

test("renames a body by double-clicking it", async ({ page }) => {
  const box = await addShape(page, "box");

  await page.getByTestId(`browser-name-${box.id}`).dblclick();
  await page.getByTestId(`browser-rename-${box.id}`).fill("Grundplatte");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId(`browser-name-${box.id}`)).toHaveText("Grundplatte");
  const state = await sceneState(page);
  expect(state.shapes[0]?.name).toBe("Grundplatte");
});

test("Escape abandons a rename without clearing the selection", async ({ page }) => {
  const box = await addShape(page, "box");

  await page.getByTestId(`browser-name-${box.id}`).dblclick();
  await page.getByTestId(`browser-rename-${box.id}`).fill("verworfen");
  await page.keyboard.press("Escape");

  await expect(page.getByTestId(`browser-name-${box.id}`)).toHaveText(box.name);
  // The editor's global Escape means "clear the selection"; abandoning a rename
  // must not reach it.
  expect((await sceneState(page)).selectedIds).toEqual([box.id]);
});

test("expands a group to show what is inside it", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("Control+a");
  await tool(page, "group").click();

  const state = await sceneState(page);
  const group = state.shapes[0];
  expect(group.groupedCount).toBeGreaterThan(1);

  await page.getByTestId(`browser-twisty-${group.id}`).click();
  await expect(page.getByTestId("browser-bodies").locator(".browser-row")).toHaveCount(1 + group.groupedCount);
});

test("closes and reopens, and the choice survives a reload", async ({ page }) => {
  await page.getByTestId("browser-close").click();
  await expect(page.getByTestId("model-browser")).toHaveCount(0);
  await expect(page.getByTestId("browser-reveal")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("add-shape")).toBeVisible();
  await expect(page.getByTestId("model-browser")).toHaveCount(0);

  await page.getByTestId("browser-reveal").click();
  await expect(page.getByTestId("model-browser")).toBeVisible();
});

test("resizes with the keyboard and remembers the width", async ({ page }) => {
  const before = (await page.getByTestId("model-browser").boundingBox())?.width ?? 0;

  const grip = page.getByTestId("browser-resize");
  await grip.focus();
  await grip.press("ArrowRight");
  await grip.press("ArrowRight");

  const after = (await page.getByTestId("model-browser").boundingBox())?.width ?? 0;
  expect(after).toBeGreaterThan(before);

  await page.reload();
  await expect(page.getByTestId("add-shape")).toBeVisible();
  const reloaded = (await page.getByTestId("model-browser").boundingBox())?.width ?? 0;
  expect(reloaded).toBeCloseTo(after, 0);
});

test("refuses to be dragged narrower than its own labels", async ({ page }) => {
  const grip = page.getByTestId("browser-resize");
  await grip.focus();
  for (let press = 0; press < 20; press += 1) await grip.press("ArrowLeft");

  const width = (await page.getByTestId("model-browser").boundingBox())?.width ?? 0;
  expect(width).toBeGreaterThanOrEqual(180);
});
