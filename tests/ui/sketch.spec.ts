import { expect, test } from "@playwright/test";
import { clickSketchPlate, enterFreehandSketch, expectShapeCount, openEditor, sceneState } from "./helpers";

/**
 * Baseline coverage of the existing freehand sketch workflow: draw a closed
 * profile on the ground plane and turn it into a body.
 *
 * This is the workflow the parametric sketcher replaces, so these tests are the
 * contract that migrating it must not break — old sketches keep opening and
 * keep producing the same kind of body.
 */

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("enters and leaves sketch mode", async ({ page }) => {
  await enterFreehandSketch(page);
  await expect(page.getByTestId("sketch-finish")).toBeVisible();

  await page.getByTestId("sketch-cancel").click();
  await expect(page.locator("svg.sketch-plate")).toHaveCount(0);
  await expectShapeCount(page, 0);
});

test("draws a closed profile and extrudes it into a body", async ({ page }) => {
  await enterFreehandSketch(page);

  await clickSketchPlate(page, 0.35, 0.35);
  await clickSketchPlate(page, 0.65, 0.35);
  await clickSketchPlate(page, 0.65, 0.65);
  await clickSketchPlate(page, 0.35, 0.65);

  const points = page.locator("g.sketch-points circle");
  await expect(points).toHaveCount(4);

  // Clicking the first point again closes the loop.
  await points.first().click();

  await page.getByTestId("sketch-finish").click();
  await expectShapeCount(page, 1);

  const body = (await sceneState(page)).shapes[0];
  expect(body.kind).toBe("mesh");
  expect(body.importedTriangles).toBeGreaterThan(0);
  expect(body.height).toBeGreaterThan(0);
});

test("refuses to finish an open profile", async ({ page }) => {
  await enterFreehandSketch(page);

  await clickSketchPlate(page, 0.35, 0.4);
  await clickSketchPlate(page, 0.6, 0.4);
  await expect(page.locator("g.sketch-points circle")).toHaveCount(2);

  await page.getByTestId("sketch-finish").click();
  // The scene is unchanged and the editor explains why.
  await expect.poll(async () => (await sceneState(page)).notice).toMatch(/close/i);
  await expectShapeCount(page, 0);
});

test("returns to the geometry tab after finishing", async ({ page }) => {
  await enterFreehandSketch(page);
  await clickSketchPlate(page, 0.35, 0.35);
  await clickSketchPlate(page, 0.65, 0.35);
  await clickSketchPlate(page, 0.5, 0.65);
  await page.locator("g.sketch-points circle").first().click();
  await page.getByTestId("sketch-finish").click();
  await expectShapeCount(page, 1);

  await expect(page.getByTestId("tab-solid")).toHaveAttribute("aria-selected", "true");
});

test("undoes an extruded sketch body", async ({ page }) => {
  await enterFreehandSketch(page);
  await clickSketchPlate(page, 0.35, 0.35);
  await clickSketchPlate(page, 0.65, 0.35);
  await clickSketchPlate(page, 0.5, 0.65);
  await page.locator("g.sketch-points circle").first().click();
  await page.getByTestId("sketch-finish").click();
  await expectShapeCount(page, 1);

  await page.keyboard.press("Control+z");
  await expectShapeCount(page, 0);
});
