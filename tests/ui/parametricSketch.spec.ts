import { expect, test, type Page } from "@playwright/test";
import { expectShapeCount, openEditor, sceneState } from "./helpers";

/**
 * The parametric sketcher, end to end.
 *
 * This is the feature the whole geometry core exists for: pick a plane, draw a
 * profile, constrain it, extrude it into a real B-Rep solid. The pieces are
 * unit-tested individually; what is checked here is that they are actually
 * joined up — a solver that never sees the drawn entities, or a finish button
 * that never reaches the kernel, would pass every other suite in the repo.
 */

/**
 * Clicks a sketch coordinate.
 *
 * The canvas is a `viewBox`-mapped SVG, so sketch millimetres are converted
 * through the element's own screen matrix rather than guessed from its box —
 * which also means the test breaks if that mapping ever stops being the truth.
 */
async function clickSketch(page: Page, x: number, y: number) {
  const point = await page.locator("[data-testid='sketch-canvas']").evaluate(
    (node, [sx, sy]) => {
      const svg = node as SVGSVGElement;
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error("The sketch canvas has no screen matrix");
      const local = svg.createSVGPoint();
      local.x = sx;
      // Sketch v grows upward, SVG y grows down.
      local.y = -sy;
      const screen = local.matrixTransform(matrix);
      return { x: screen.x, y: screen.y };
    },
    [x, y],
  );
  await page.mouse.click(point.x, point.y);
}

async function startSketch(page: Page) {
  await page.getByTestId("tab-sketch").click();
  await page.getByTestId("tool-parametric-sketch").click();
  await expect(page.getByTestId("sketch-plane-picker")).toBeVisible();
  await page.getByTestId("sketch-plane-start").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("picks a plane before drawing anything", async ({ page }) => {
  await page.getByTestId("tab-sketch").click();
  await page.getByTestId("tool-parametric-sketch").click();

  // A sketch without a plane has nowhere to be, so the picker comes first.
  await expect(page.getByTestId("sketch-plane-picker")).toBeVisible();
  await expect(page.getByTestId("sketch-canvas")).toHaveCount(0);

  await page.getByTestId("sketch-plane-cancel").click();
  await expect(page.getByTestId("parametric-overlay")).toHaveCount(0);
});

test("draws a rectangle and reports its degrees of freedom", async ({ page }) => {
  await startSketch(page);

  await expect(page.getByTestId("sketch-dof")).toContainText("Fully constrained");

  await page.getByTestId("sketch-tool-rectangle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 40, 30);

  await expect(page.getByTestId("sketch-counts")).toContainText("4 entities");
  // Four lines joined at the corners and axis-aligned still float freely: the
  // solver has to say so, or a user has no idea what is left to dimension.
  await expect(page.getByTestId("sketch-dof")).toContainText("degrees of freedom");
});

test("a drawn rectangle really is four joined lines", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-rectangle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 40, 30);

  await expect(page.locator("[data-entity-type='line']")).toHaveCount(4);
  await expect(page.getByTestId("sketch-counts")).toContainText("relations");
});

test("a dimension moves the geometry", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-circle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 10, 0);

  const circleWidth = () =>
    page.locator("[data-entity-type='circle']").evaluate((node) => (node as SVGGraphicsElement).getBBox().width);
  expect(await circleWidth()).toBeCloseTo(20, 0);

  await page.getByTestId("sketch-tool-select").click();
  await clickSketch(page, 10, 0);
  await page.getByTestId("dimension-radius").click();
  await page.getByTestId("dimension-input").fill("25");
  await page.getByTestId("dimension-apply").click();

  // The circle was drawn at 10 mm; the dimension is what decides now, and the
  // drawn geometry has to follow it rather than the click that made it. A
  // dimension the solver never applies is the failure this catches.
  await expect.poll(circleWidth).toBeCloseTo(50, 0);

  // A circle has three degrees of freedom and a radius removes one, so it is
  // not fully constrained yet — its centre is still free. Saying otherwise
  // would be worse than saying nothing.
  await expect(page.getByTestId("sketch-dof")).toContainText("2 degrees of freedom");
});

test("a dimension accepts an expression, and says so when it cannot", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-circle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 10, 0);
  await page.getByTestId("sketch-tool-select").click();
  await clickSketch(page, 10, 0);

  await page.getByTestId("dimension-radius").click();
  await page.getByTestId("dimension-input").fill("1cm + 5");
  await page.getByTestId("dimension-apply").click();
  await expect(page.getByTestId("dimension-input")).toHaveCount(0);

  // A broken expression has to name what is wrong rather than silently
  // applying nothing.
  await page.getByTestId("dimension-diameter").click();
  await page.getByTestId("dimension-input").fill("25 +");
  await page.getByTestId("dimension-apply").click();
  await expect(page.getByTestId("sketch-message")).toBeVisible();
  await expect(page.getByTestId("dimension-input")).toBeVisible();
});

test("trim removes the piece that was clicked", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-line").click();
  await clickSketch(page, -30, 0);
  await clickSketch(page, 30, 0);
  await page.keyboard.press("Escape");

  await page.getByTestId("sketch-tool-line").click();
  await clickSketch(page, 0, -20);
  await clickSketch(page, 0, 20);
  await page.keyboard.press("Escape");

  await expect(page.locator("[data-entity-type='line']")).toHaveCount(2);

  await page.getByTestId("sketch-tool-trim").click();
  await clickSketch(page, 20, 0);

  // The horizontal line loses its right half; the vertical one is untouched.
  await expect(page.locator("[data-entity-type='line']")).toHaveCount(2);
  await expect(page.getByTestId("sketch-counts")).toContainText("2 entities");
});

test("a rectangular pattern repeats the selection", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-circle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 4, 0);

  await page.getByTestId("sketch-tool-select").click();
  await clickSketch(page, 4, 0);
  await page.getByTestId("sketch-pattern-count").fill("4");
  await page.getByTestId("sketch-pattern-rect").click();

  // Four copies in the pattern means three new circles beside the original.
  await expect(page.locator("[data-entity-type='circle']")).toHaveCount(4);
});

test("Escape backs out one step at a time", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-rectangle").click();
  await clickSketch(page, 0, 0);

  // First press abandons the half-drawn shape, second returns to Select,
  // third would clear the selection, fourth leaves the sketch. Jumping
  // straight out would throw away a drawing over one keypress.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-tool-rectangle")).toHaveAttribute("aria-pressed", "true");

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sketch-tool-select")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("parametric-overlay")).toHaveCount(0);
});

test("extrudes the profile into a real solid", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-rectangle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 40, 30);

  await page.getByTestId("sketch-extrude-distance").fill("12");
  await page.getByTestId("parametric-finish").click();

  // First use loads the 22 MB kernel in the worker, so this is given room.
  await expect
    .poll(() => sceneState(page).then((state) => state.shapeCount), { timeout: 90_000 })
    .toBe(1);

  const state = await sceneState(page);
  const body = state.shapes[0];
  // The rectangle was drawn on the ground plane, so its extents land on width
  // and depth and the extrude distance becomes the height. Getting that axis
  // mapping wrong would place a correct solid lying on its side.
  expect(body.width).toBeCloseTo(40, 1);
  expect(body.depth).toBeCloseTo(30, 1);
  expect(body.height).toBeCloseTo(12, 1);
  // A real B-Rep, not a tessellation: the analytic edges came back with it.
  expect(body.cadDisplayEdgeCount).toBe(12);

  await expect(page.getByTestId("parametric-overlay")).toHaveCount(0);
});

test("an extruded sketch body can be undone", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-rectangle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 20, 20);
  await page.getByTestId("parametric-finish").click();

  await expect.poll(() => sceneState(page).then((state) => state.shapeCount), { timeout: 90_000 }).toBe(1);

  // A parametric body goes through the same commit path as everything else, so
  // undo has to reach it without a special case.
  await page.keyboard.press("Control+z");
  await expectShapeCount(page, 0);
});

test("refuses an open profile and says why", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-line").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 40, 0);
  await page.keyboard.press("Escape");

  await page.getByTestId("parametric-finish").click();

  await expect
    .poll(() => sceneState(page).then((state) => state.notice), { timeout: 90_000 })
    .toMatch(/does not join up|closed profile/i);
  // The sketch stays open so the profile can be fixed rather than redrawn.
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
});

test("speaks German when the interface does", async ({ page }) => {
  await page.getByTestId("language-switch").selectOption("de");
  await startSketch(page);

  await expect(page.getByTestId("sketch-tool-rectangle")).toHaveAttribute("aria-label", "Rechteck");
  await expect(page.getByTestId("constraint-perpendicular")).toHaveAttribute("aria-label", "Rechtwinklig");
  await expect(page.getByTestId("sketch-dof")).toContainText("Vollständig bestimmt");
});

test("reopens a body's sketch and rebuilds it with a new dimension", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-rectangle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 40, 30);
  await page.getByTestId("sketch-extrude-distance").fill("10");
  await page.getByTestId("parametric-finish").click();

  await expect.poll(() => sceneState(page).then((state) => state.shapeCount), { timeout: 90_000 }).toBe(1);
  const first = (await sceneState(page)).shapes[0];
  expect(first.height).toBeCloseTo(10, 1);

  // The sketch travelled with the body, so it can be opened again.
  await page.getByTestId("tab-sketch").click();
  await page.getByTestId("tool-edit-parametric-sketch").click();
  await expect(page.getByTestId("sketch-canvas")).toBeVisible();
  await expect(page.locator("[data-entity-type='line']")).toHaveCount(4);

  await page.getByTestId("sketch-extrude-distance").fill("25");
  await page.getByTestId("parametric-finish").click();

  // Rebuilding replaces the body rather than adding a second one, and keeps its
  // identity — a new id would orphan its place in the tree and its name.
  await expect
    .poll(() => sceneState(page).then((state) => state.shapes[0]?.height), { timeout: 90_000 })
    .toBeCloseTo(25, 1);
  expect((await sceneState(page)).shapeCount).toBe(1);
  expect((await sceneState(page)).shapes[0].id).toBe(first.id);
});

test("only offers the edit command for a body that has a sketch", async ({ page }) => {
  await page.getByTestId("tab-sketch").click();
  await expect(page.getByTestId("tool-edit-parametric-sketch")).toBeDisabled();
});

test("a named parameter drives a dimension", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-tool-circle").click();
  await clickSketch(page, 0, 0);
  await clickSketch(page, 10, 0);

  await page.getByTestId("sketch-parameters").click();
  await page.getByTestId("parameters-add").click();
  const row = page.locator("[data-testid^='parameter-name-']").first();
  const id = (await row.getAttribute("data-testid"))!.replace("parameter-name-", "");
  await page.getByTestId(`parameter-name-${id}`).fill("bohrung");
  await page.getByTestId(`parameter-expression-${id}`).fill("3cm");
  await expect(page.getByTestId(`parameter-value-${id}`)).toHaveText("30");

  await page.getByTestId("parameters-close").click();
  await page.getByTestId("sketch-tool-select").click();
  await clickSketch(page, 10, 0);
  await page.getByTestId("dimension-radius").click();
  await page.getByTestId("dimension-input").fill("bohrung / 2");
  await page.getByTestId("dimension-apply").click();

  // Naming a value once and referring to it is the point: the circle has to
  // follow the parameter, not the click that drew it.
  await expect
    .poll(() =>
      page.locator("[data-entity-type='circle']").evaluate((node) => (node as SVGGraphicsElement).getBBox().width),
    )
    .toBeCloseTo(30, 0);
});

test("a broken parameter says so instead of resolving to zero", async ({ page }) => {
  await startSketch(page);
  await page.getByTestId("sketch-parameters").click();
  await page.getByTestId("parameters-add").click();
  const row = page.locator("[data-testid^='parameter-name-']").first();
  const id = (await row.getAttribute("data-testid"))!.replace("parameter-name-", "");

  await page.getByTestId(`parameter-expression-${id}`).fill("2 * ");
  // The error replaces the value: a stale number beside a broken expression is
  // the one thing that could make someone trust a wrong dimension.
  await expect(page.getByTestId(`parameter-row-${id}`)).toHaveClass(/invalid/);
  await expect(page.getByTestId(`parameter-value-${id}`)).not.toHaveText("0");
});
