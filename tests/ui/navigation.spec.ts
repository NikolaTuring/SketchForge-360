import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, openEditor, sceneState, selectAll } from "./helpers";

/**
 * Viewport navigation and the right-click menu.
 *
 * The camera has no queryable state, so "fit" is asserted through the one
 * observable it does have: the orientation cube's transform, which is derived
 * from the camera's offset from its target. A fit that moves the camera without
 * turning it must therefore leave the cube alone — which is exactly the property
 * worth locking down, because a fit that also reorients throws away the angle
 * someone set up.
 */

/**
 * A point well inside the canvas.
 *
 * The corners belong to the camera controls and the orientation cube, which
 * would swallow the click before the viewport ever saw it.
 */
const VIEWPORT_POINT = { x: 420, y: 380 };

async function cubeTransform(page: import("@playwright/test").Page) {
  return page.locator(".view-cube-inner").evaluate((node) => getComputedStyle(node).transform);
}

/**
 * The cube's transform once the camera has stopped moving.
 *
 * The orbit controls damp every change, so reading straight after a view
 * command catches the camera mid-flight and compares two arbitrary points along
 * the same journey. Two consecutive readings that agree is what "settled" means
 * here — there is no event to wait for.
 */
async function settledCube(page: import("@playwright/test").Page) {
  let previous = await cubeTransform(page);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.waitForTimeout(50);
    const current = await cubeTransform(page);
    if (current === previous) return current;
    previous = current;
  }
  throw new Error("The camera never settled");
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("the orientation cube sits in the top right", async ({ page }) => {
  const cube = await page.locator(".view-cube").boundingBox();
  const stage = await page.locator(".workplane-stage").boundingBox();
  if (!cube || !stage) throw new Error("The viewport has no layout box");

  expect(cube.x).toBeGreaterThan(stage.x + stage.width / 2);
  expect(cube.y).toBeLessThan(stage.y + stage.height / 2);
});

test("fit keeps the viewing direction; Home is what resets it", async ({ page }) => {
  await addShape(page, "box");
  const start = await settledCube(page);

  // Look from somewhere other than the start view, so the two commands have
  // something to disagree about. The cube faces are rotated in 3D, so the one
  // facing away cannot be hit-tested; the click is dispatched straight at it.
  await page.getByRole("button", { name: "Top view" }).dispatchEvent("click");
  const chosen = await settledCube(page);
  expect(chosen).not.toBe(start);

  await page.getByTestId("camera-fit").click();
  // This is the property worth locking down: fit answers "I have lost the
  // model", not "put me back at the beginning".
  expect(await settledCube(page)).toBe(chosen);

  await page.locator("canvas").first().click({ position: VIEWPORT_POINT });
  await page.keyboard.press("Home");
  expect(await settledCube(page)).toBe(start);
});

test("F fits from the keyboard without resetting the view", async ({ page }) => {
  await addShape(page, "box");
  await page.getByRole("button", { name: "Right view" }).dispatchEvent("click");
  const chosen = await settledCube(page);

  await page.locator("canvas").first().click({ position: VIEWPORT_POINT });
  await page.keyboard.press("f");

  // F used to be a second name for Home, which meant the only way to recover a
  // lost model also threw away the angle you had set up.
  expect(await settledCube(page)).toBe(chosen);
});

test("fit works with nothing selected", async ({ page }) => {
  await addShape(page, "box");
  await page.keyboard.press("Escape");
  expect((await sceneState(page)).selectedIds).toEqual([]);

  // Nothing selected means "frame everything", not "refuse" — someone who has
  // scrolled into empty space has nothing to select.
  await page.getByTestId("camera-fit").click();
  await expect(page.locator(".view-cube")).toBeVisible();
});

test("the edge tool panel does not cover the orientation cube", async ({ page }) => {
  await addShape(page, "box");
  await page.getByTestId("tool-fillet").click();
  await expect(page.getByTestId("edge-modifier-panel")).toBeVisible();

  const cube = await page.locator(".view-cube").boundingBox();
  const panel = await page.getByTestId("edge-modifier-panel").boundingBox();
  if (!cube || !panel) throw new Error("Missing layout box");

  // Picking edges is the task that most needs the view rotated.
  expect(panel.y).toBeGreaterThanOrEqual(cube.y + cube.height);
});

test("right-click offers the commands that apply", async ({ page }) => {
  await addShape(page, "box");
  await page.locator("canvas").first().click({ button: "right", position: VIEWPORT_POINT });

  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("context-delete")).toBeVisible();
  await expect(page.getByTestId("context-duplicate")).toBeVisible();
  // One body cannot be grouped with itself, so the entry is absent rather than
  // present and dead.
  await expect(page.getByTestId("context-group")).toHaveCount(0);
});

test("right-click grows with the selection", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await selectAll(page);

  await page.locator("canvas").first().click({ button: "right", position: VIEWPORT_POINT });
  await expect(page.getByTestId("context-group")).toBeVisible();
});

test("a context command runs and closes the menu", async ({ page }) => {
  await addShape(page, "box");
  await page.locator("canvas").first().click({ button: "right", position: VIEWPORT_POINT });

  await page.getByTestId("context-duplicate").click();
  await expect(page.getByTestId("context-menu")).toHaveCount(0);
  await expectShapeCount(page, 2);
});

test("Escape dismisses the menu without clearing the selection", async ({ page }) => {
  const box = await addShape(page, "box");
  await page.locator("canvas").first().click({ button: "right", position: VIEWPORT_POINT });
  await expect(page.getByTestId("context-menu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("context-menu")).toHaveCount(0);
  expect((await sceneState(page)).selectedIds).toEqual([box.id]);
});

test("right-clicking a browser row selects it first", async ({ page }) => {
  const box = await addShape(page, "box");
  const cylinder = await addShape(page, "cylinder");
  expect((await sceneState(page)).selectedIds).toEqual([cylinder.id]);

  await page.getByTestId(`browser-name-${box.id}`).click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  expect((await sceneState(page)).selectedIds).toEqual([box.id]);
});

test("the menu stays on screen near the window edge", async ({ page }) => {
  await addShape(page, "box");
  await page.keyboard.press("Control+c");
  // Clear the selection so the shape inspector — which deliberately swallows
  // pointer events — is not sitting in the corner under test. Paste survives an
  // empty selection, so the menu still has something to show.
  await page.keyboard.press("Escape");

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The page has no viewport size");

  await page.mouse.move(viewport.width - 6, viewport.height - 40);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });

  const menu = await page.getByTestId("context-menu").boundingBox();
  if (!menu) throw new Error("The menu has no layout box");
  expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width);
  expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height);
});
