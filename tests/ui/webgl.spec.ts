import { expect, test, type Page } from "@playwright/test";

/**
 * What happens on a machine that cannot draw 3D.
 *
 * This is not a hypothetical. It is an old laptop, a remote desktop session, a
 * driver on the browser's blocklist, or hardware acceleration switched off by
 * policy — which describes a great many school computers. Before the guard, the
 * failed WebGL context took the whole editor down with it: no ribbon, no model
 * browser, no sketcher, just a stack trace.
 *
 * The point of these tests is the second half. Losing the 3D view is
 * unavoidable; losing the sketcher with it is not, because the sketcher is
 * plain SVG and has no reason to care.
 */

/** Makes the browser refuse every WebGL context, as a blocked driver would. */
async function withoutWebgl(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    // Only the 3D contexts are refused. Blanking `getContext` entirely would
    // also break 2D canvas work and stop testing the thing under test.
    HTMLCanvasElement.prototype.getContext = function patched(
      this: HTMLCanvasElement,
      kind: string,
      ...rest: unknown[]
    ) {
      if (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl") return null;
      return (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
}

test.describe("without WebGL", () => {
  test.beforeEach(async ({ page }) => {
    await withoutWebgl(page);
    await page.goto("/?editor=1");
  });

  test("explains itself instead of crashing", async ({ page }) => {
    const card = page.getByTestId("webgl-unavailable");
    await expect(card).toBeVisible();
    await expect(card).toContainText("cannot show the 3D view");
    // The three steps someone can actually take, in order of how likely they
    // are to work.
    await expect(card).toContainText("Edge");
    await expect(card).toContainText("hardware acceleration");
    await expect(card).toContainText("graphics driver");
  });

  test("keeps the rest of the editor alive", async ({ page }) => {
    // Every one of these went down with the viewport before the guard.
    await expect(page.getByTestId("add-shape")).toBeVisible();
    await expect(page.getByTestId("model-browser")).toBeVisible();
    await expect(page.getByTestId("status-bar")).toBeVisible();
    await expect(page.getByTestId("tab-sketch")).toBeVisible();
  });

  test("still lets you sketch", async ({ page }) => {
    await page.getByTestId("tab-sketch").click();
    await page.getByTestId("tool-parametric-sketch").click();
    await page.getByTestId("sketch-plane-start").click();
    await expect(page.getByTestId("sketch-canvas")).toBeVisible();

    // Drawing, relations and dimensions are SVG and arithmetic; none of it
    // needs a GPU. Only the finished body cannot be shown.
    const point = await page.locator("[data-testid='sketch-canvas']").evaluate((node) => {
      const svg = node as SVGSVGElement;
      const matrix = svg.getScreenCTM();
      if (!matrix) throw new Error("The sketch canvas has no screen matrix");
      const at = (x: number, y: number) => {
        const local = svg.createSVGPoint();
        local.x = x;
        local.y = -y;
        const screen = local.matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
      };
      return { a: at(0, 0), b: at(40, 30) };
    });

    await page.getByTestId("sketch-tool-rectangle").click();
    await page.mouse.click(point.a.x, point.a.y);
    await page.mouse.click(point.b.x, point.b.y);

    await expect(page.locator("[data-entity-type='line']")).toHaveCount(4);
    await expect(page.getByTestId("sketch-dof")).toContainText("degrees of freedom");
  });

  test("says it in German too", async ({ page }) => {
    await page.getByTestId("language-switch").selectOption("de");
    await expect(page.getByTestId("webgl-unavailable")).toContainText("3D-Ansicht");
    await expect(page.getByTestId("webgl-unavailable")).toContainText("Hardwarebeschleunigung");
  });
});

test("shows no such card on a machine that can draw", async ({ page }) => {
  await page.goto("/?editor=1");
  await expect(page.getByTestId("add-shape")).toBeVisible();
  // The probe must not produce a false alarm on a working browser — and it must
  // not consume the context it was probing for.
  await expect(page.getByTestId("webgl-unavailable")).toHaveCount(0);
  await expect(page.locator(".workplane-stage canvas")).toBeVisible();
});
