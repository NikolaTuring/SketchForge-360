import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, openEditor, sceneState, selectAll, tool } from "./helpers";

/**
 * Baseline coverage of the solid/hole and grouping workflow — the loop the
 * README describes as the core of the app. Booleans run through WASM, so these
 * are slower than the plain shape tests and get their own timeout.
 */

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("turns a shape into a hole and back", async ({ page }) => {
  await addShape(page, "cylinder");

  await page.keyboard.press("h");
  await expect.poll(async () => (await sceneState(page)).shapes[0].hole).toBe(true);

  await page.keyboard.press("s");
  await expect.poll(async () => (await sceneState(page)).shapes[0].hole).toBe(false);
});

test("cuts a hole out of a solid by grouping", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");

  // The cylinder is still selected; make it the cutter, then group both.
  await page.keyboard.press("h");
  await expect.poll(async () => (await sceneState(page)).shapes[1].hole).toBe(true);

  await selectAll(page);
  await expect.poll(async () => (await sceneState(page)).selectedIds.length).toBe(2);

  await tool(page, "group").click();
  await expectShapeCount(page, 1);

  const result = (await sceneState(page)).shapes[0];
  // A boolean bakes down to a mesh body that still remembers its operands.
  expect(result.kind).toBe("mesh");
  expect(result.importedTriangles).toBeGreaterThan(0);
});

test("ungroups back into the original operands", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await selectAll(page);
  await tool(page, "group").click();
  await expectShapeCount(page, 1);

  await tool(page, "ungroup").click();
  await expectShapeCount(page, 2);
  expect((await sceneState(page)).shapes.map((shape) => shape.kind).sort()).toEqual(["box", "cylinder"]);
});

test("undoes a grouping in one step", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await selectAll(page);
  await tool(page, "group").click();
  await expectShapeCount(page, 1);

  await tool(page, "undo").click();
  await expectShapeCount(page, 2);
});

test("keeps intersection disabled without both a solid and a hole", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await selectAll(page);
  await expect(tool(page, "intersect")).toBeDisabled();

  // Make one of them a cutter and the operation becomes available.
  await page.getByTestId("add-shape").click();
  await page.getByTestId("shape-menu-sphere").click();
  await page.keyboard.press("h");
  await selectAll(page);
  await expect(tool(page, "intersect")).toBeEnabled();
});
