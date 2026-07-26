import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, notice, openEditor, sceneState, selectAll, tool } from "./helpers";

/**
 * Baseline coverage of the existing direct-modelling workflow.
 *
 * These tests describe behaviour that already shipped. They exist to fail loudly
 * if the editor rework changes it, so they must keep passing unmodified.
 */

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("opens the editor with an empty scene", async ({ page }) => {
  const state = await sceneState(page);
  expect(state.shapeCount).toBe(0);
  expect(state.selectedIds).toEqual([]);
});

test("adds a primitive from the shape menu and selects it", async ({ page }) => {
  const box = await addShape(page, "box");

  expect(box.kind).toBe("box");
  expect(box.hole).toBe(false);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  const state = await sceneState(page);
  expect(state.selectedIds).toEqual([box.id]);
});

test("adds several primitives of different kinds", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await addShape(page, "sphere");

  const state = await sceneState(page);
  expect(state.shapes.map((shape) => shape.kind)).toEqual(["box", "cylinder", "sphere"]);
});

test("duplicates the selection", async ({ page }) => {
  await addShape(page, "box");
  await tool(page, "duplicate").click();

  await expectShapeCount(page, 2);
  const state = await sceneState(page);
  // The copy is offset so it does not hide inside the original.
  expect(state.shapes[1].x).not.toBe(state.shapes[0].x);
  expect(state.shapes[1].kind).toBe("box");
});

test("deletes the selection and restores it with undo", async ({ page }) => {
  const box = await addShape(page, "box");

  await tool(page, "delete").click();
  await expectShapeCount(page, 0);

  await tool(page, "undo").click();
  await expectShapeCount(page, 1);
  expect((await sceneState(page)).shapes[0].id).toBe(box.id);

  await tool(page, "redo").click();
  await expectShapeCount(page, 0);
});

test("undo and redo work from the keyboard", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");
  await expectShapeCount(page, 2);

  await page.keyboard.press("Control+z");
  await expectShapeCount(page, 1);

  await page.keyboard.press("Control+y");
  await expectShapeCount(page, 2);
});

test("selects everything with the keyboard and deletes it", async ({ page }) => {
  await addShape(page, "box");
  await addShape(page, "cylinder");

  await selectAll(page);
  await expect.poll(async () => (await sceneState(page)).selectedIds.length).toBe(2);

  await page.keyboard.press("Delete");
  await expectShapeCount(page, 0);
});

test("copies and pastes a shape", async ({ page }) => {
  await addShape(page, "cylinder");

  await tool(page, "copy").click();
  await tool(page, "paste").click();

  await expectShapeCount(page, 2);
  expect((await sceneState(page)).shapes.map((shape) => shape.kind)).toEqual(["cylinder", "cylinder"]);
});

test("reports an action in the notice line", async ({ page }) => {
  await addShape(page, "box");
  expect(await notice(page)).toMatch(/box/i);
});

test("disables selection-dependent tools when nothing is selected", async ({ page }) => {
  await expect(tool(page, "delete")).toBeDisabled();
  await expect(tool(page, "duplicate")).toBeDisabled();
  await expect(tool(page, "group")).toBeDisabled();

  await addShape(page, "box");
  await expect(tool(page, "delete")).toBeEnabled();
  await expect(tool(page, "duplicate")).toBeEnabled();
});
