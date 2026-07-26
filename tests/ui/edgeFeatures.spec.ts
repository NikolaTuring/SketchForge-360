import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, openEditor, sceneState, tool } from "./helpers";

/**
 * Baseline coverage of the fillet and chamfer tools.
 *
 * These drive the OpenCascade worker, which streams a 22 MB WebAssembly kernel
 * on first use, so they are by far the slowest tests here — and the most worth
 * having, because they are the only ones that exercise the worker session
 * lifecycle end to end.
 */

test.describe.configure({ timeout: 300_000 });

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

/** Waits for the worker to finish loading the kernel and enumerating edges. */
async function waitForPreparedPanel(page: import("@playwright/test").Page) {
  await expect(page.getByTestId("edge-modifier-panel")).toBeVisible();
  await expect(page.getByTestId("edge-modifier-select-all")).toBeEnabled({ timeout: 240_000 });
}

test("fillets every sharp edge of a box", async ({ page }) => {
  await addShape(page, "box");

  await tool(page, "fillet").click();
  await waitForPreparedPanel(page);

  await page.getByTestId("edge-modifier-select-all").click();
  await expect(page.getByTestId("edge-modifier-apply")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("edge-modifier-apply").click();

  await expect(page.getByTestId("edge-modifier-panel")).toHaveCount(0);
  await expectShapeCount(page, 1);

  const body = (await sceneState(page)).shapes[0];
  // A filleted box bakes into a mesh body that records the feature it carries.
  expect(body.kind).toBe("mesh");
  expect(body.edgeTreatments.length).toBe(1);
  expect(body.edgeTreatments[0].kind).toBe("fillet");
  expect(body.edgeTreatments[0].edgeCount).toBeGreaterThan(0);
  expect(body.cadDisplayEdgeCount).toBeGreaterThan(0);
});

test("chamfers a box and undoes it", async ({ page }) => {
  const box = await addShape(page, "box");

  await tool(page, "chamfer").click();
  await waitForPreparedPanel(page);
  await page.getByTestId("edge-modifier-select-all").click();
  await expect(page.getByTestId("edge-modifier-apply")).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId("edge-modifier-apply").click();

  await expect.poll(async () => (await sceneState(page)).shapes[0].edgeTreatments.length, {
    timeout: 120_000,
  }).toBe(1);
  expect((await sceneState(page)).shapes[0].edgeTreatments[0].kind).toBe("chamfer");

  await tool(page, "undo").click();
  await expect.poll(async () => (await sceneState(page)).shapes[0].edgeTreatments.length).toBe(0);
  expect((await sceneState(page)).shapes[0].id).toBe(box.id);
});

test("cancels the edge tool without touching the body", async ({ page }) => {
  await addShape(page, "box");
  const before = (await sceneState(page)).shapes[0];

  await tool(page, "fillet").click();
  await waitForPreparedPanel(page);
  await page.getByTestId("edge-modifier-cancel").click();

  await expect(page.getByTestId("edge-modifier-panel")).toHaveCount(0);
  const after = (await sceneState(page)).shapes[0];
  expect(after.kind).toBe(before.kind);
  expect(after.edgeTreatments).toEqual([]);
});

test("needs Escape twice to close the edge tool", async ({ page }) => {
  await addShape(page, "box");
  await tool(page, "fillet").click();
  await waitForPreparedPanel(page);

  // Recording a known defect, not endorsing it.
  //
  // Two window keydown listeners handle Escape. The global one runs first and
  // clears the selection, which changes the dependencies of the edge tool's own
  // listener effect; React then tears that listener down *during the same event
  // dispatch*, and a listener removed mid-dispatch is never called. So the first
  // Escape only clears the selection and leaves the tool open.
  //
  // Phase 2 routes keyboard shortcuts through the command registry and must fix
  // this. When it does, this test will fail — that is the signal to update it to
  // expect a single Escape.
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await sceneState(page)).selectedIds.length).toBe(0);
  await expect(page.getByTestId("edge-modifier-panel")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("edge-modifier-panel")).toHaveCount(0);
});
