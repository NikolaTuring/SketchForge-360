import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Shared helpers for the browser tests.
 *
 * Everything here reads the editor's own hidden state dump rather than the
 * rendered DOM. The viewport is a WebGL canvas with no queryable structure, so
 * `pre[data-codex-state]` is the only reliable way to assert what the scene
 * actually contains — and it is stable across translation and restyling.
 */

export type DebugShape = {
  id: string;
  name: string;
  kind: string;
  hole: boolean;
  x: number;
  z: number;
  elevation: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  rotationX: number;
  rotationZ: number;
  mirrorX: boolean;
  mirrorY: boolean;
  mirrorZ: boolean;
  importedTriangles: number;
  edgeTreatments: { kind: string; amount: number; edgeCount: number }[];
  cadDisplayEdgeCount: number | null;
  groupedShapes?: number;
};

export type DebugState = {
  notice: string;
  selectedIds: string[];
  shapeCount: number;
  shapes: DebugShape[];
};

/**
 * Opens the editor directly, bypassing the dashboard.
 *
 * No storage clearing is needed or wanted: Playwright gives every test a fresh
 * browser context, so localStorage and IndexedDB start empty. Clearing via an
 * init script would additionally wipe them on *every* navigation, which silently
 * breaks any test that reloads the page to check persistence.
 */
export async function openEditor(page: Page) {
  await page.goto("/?editor=1");
  await expect(page.getByTestId("add-shape")).toBeVisible();
  await expect.poll(() => sceneState(page).then((state) => state.shapeCount)).toBe(0);
}

export async function sceneState(page: Page): Promise<DebugState> {
  const raw = await page.locator("pre[data-codex-state]").textContent();
  if (!raw) throw new Error("The editor did not publish a scene state dump");
  return JSON.parse(raw) as DebugState;
}

export async function shapeCount(page: Page) {
  return (await sceneState(page)).shapeCount;
}

/** Waits until the scene settles on the expected number of shapes. */
export async function expectShapeCount(page: Page, expected: number) {
  await expect.poll(() => shapeCount(page), { timeout: 20_000 }).toBe(expected);
}

/** Adds a primitive through the ribbon's shape menu. */
export async function addShape(page: Page, id: "box" | "cylinder" | "sphere" | "cone" | "wedge") {
  const before = await shapeCount(page);
  await page.getByTestId("add-shape").click();
  await page.getByTestId(`shape-menu-${id}`).click();
  await expectShapeCount(page, before + 1);
  const state = await sceneState(page);
  return state.shapes[state.shapes.length - 1];
}

export function tool(page: Page, id: string): Locator {
  return page.getByTestId(`tool-${id}`);
}

/** Selects every visible shape via the keyboard, matching the editor binding. */
export async function selectAll(page: Page) {
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("Control+a");
}

/** The most recent toast text. */
export async function notice(page: Page) {
  return (await sceneState(page)).notice;
}

/**
 * Clicks a point on the sketch plate, addressed in fractions of the plate.
 *
 * The plate is square and sized from the workspace, so it is routinely taller
 * than the window and hangs off the bottom. Fractions are therefore mapped into
 * the visible intersection of the plate and the viewport — clicking outside it
 * lands on nothing and is silently lost.
 */
export async function clickSketchPlate(page: Page, fractionX: number, fractionY: number) {
  const plate = page.locator("svg.sketch-plate");
  const box = await plate.boundingBox();
  if (!box) throw new Error("The sketch plate has no layout box");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The page has no viewport size");

  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, viewport.width);
  const bottom = Math.min(box.y + box.height, viewport.height);
  if (right - left < 8 || bottom - top < 8) throw new Error("The sketch plate is not visible");

  await page.mouse.click(left + (right - left) * fractionX, top + (bottom - top) * fractionY);
}

/** Enters the freehand sketch mode with the extrude operation selected. */
export async function enterFreehandSketch(page: Page) {
  await page.getByTestId("tab-sketch").click();
  await page.getByTestId("sketch-create-menu").click();
  await page.getByTestId("sketch-start-extrude").click();
  await expect(page.locator("svg.sketch-plate")).toBeVisible();
}
