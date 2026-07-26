import { expect, test, type Page } from "@playwright/test";
import { addShape, openEditor, tool } from "./helpers";

/**
 * The editor shell.
 *
 * The shell is a two-row grid: ribbon, then everything else. Before that it was
 * two `position: fixed` layers whose heights were kept in step by hand through
 * `--editor-toolbar-height`, which is exactly the arrangement that has no room
 * for docks. These tests assert the property that made the grid worth it — the
 * rows meet exactly, with no overlap and no gap — because a one-pixel drift
 * there is invisible in a screenshot and obvious to a user whose ribbon eats
 * the top of the model.
 */

async function box(page: Page, selector: string) {
  const rect = await page.locator(selector).boundingBox();
  if (!rect) throw new Error(`${selector} has no layout box`);
  return rect;
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("the ribbon and the body tile the window exactly", async ({ page }) => {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The page has no viewport size");

  const ribbon = await box(page, ".secondary-toolbar");
  const body = await box(page, ".editor-body");

  expect(ribbon.y).toBeCloseTo(0, 0);
  // The seam: the body starts where the ribbon ends. A gap shows the page
  // background, an overlap hides the top of the viewport behind the ribbon.
  expect(body.y).toBeCloseTo(ribbon.y + ribbon.height, 0);
  expect(body.y + body.height).toBeCloseTo(viewport.height, 0);
  expect(body.width).toBeCloseTo(viewport.width, 0);
});

test("the window itself never scrolls", async ({ page }) => {
  const overflow = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - window.innerHeight,
    horizontal: document.documentElement.scrollWidth - window.innerWidth,
  }));

  expect(overflow.vertical).toBeLessThanOrEqual(0);
  expect(overflow.horizontal).toBeLessThanOrEqual(0);
});

test("the viewport fills the body", async ({ page }) => {
  const body = await box(page, ".editor-body");
  const stage = await box(page, ".workplane-stage");

  expect(stage.height).toBeCloseTo(body.height, 0);
  expect(stage.width).toBeCloseTo(body.width, 0);

  // The canvas has to follow the stage, not just sit inside it: a canvas that
  // keeps its old size renders the scene at the wrong aspect ratio.
  const canvas = await box(page, ".workplane-stage canvas");
  expect(canvas.height).toBeCloseTo(stage.height, 0);
  expect(canvas.width).toBeCloseTo(stage.width, 0);
});

test("floating panels stay clear of the ribbon", async ({ page }) => {
  await addShape(page, "box");
  await tool(page, "fillet").click();
  const panel = page.getByTestId("edge-modifier-panel");
  await expect(panel).toBeVisible();

  const ribbon = await box(page, ".secondary-toolbar");
  const rect = await box(page, "[data-testid='edge-modifier-panel']");
  expect(rect.y).toBeGreaterThanOrEqual(ribbon.y + ribbon.height);
});

test("the shell still tiles the window when the ribbon grows on a narrow window", async ({ page }) => {
  // Narrow enough for the ribbon's own media queries to change its height —
  // the case the old hand-maintained `100vh - toolbar` arithmetic got wrong.
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(page.getByTestId("add-shape")).toBeVisible();

  const ribbon = await box(page, ".secondary-toolbar");
  const body = await box(page, ".editor-body");

  expect(body.y).toBeCloseTo(ribbon.y + ribbon.height, 0);
  expect(body.y + body.height).toBeCloseTo(700, 0);
});
