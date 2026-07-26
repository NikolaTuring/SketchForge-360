import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, sceneState, tool } from "./helpers";

/**
 * Baseline coverage of project persistence.
 *
 * Projects live entirely in the browser: metadata in localStorage, geometry in
 * IndexedDB, written on a debounce. This is the one workflow where losing data
 * is unrecoverable, so it is worth pinning down before the editor is reworked.
 */

test.describe.configure({ timeout: 180_000 });

/** Creates a project from the dashboard and lands in the editor. */
async function createProject(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("dashboard-create-project").click();
  await expect(page.getByTestId("add-shape")).toBeVisible();
  await expect.poll(() => page.url()).toMatch(/project=/);
  return page.url();
}

test("keeps a project's shapes across a reload", async ({ page }) => {
  const projectUrl = await createProject(page);

  await addShape(page, "box");
  await addShape(page, "cylinder");
  await expectShapeCount(page, 2);

  // The editor writes on a debounce; give it room before navigating away.
  await page.waitForTimeout(1500);
  await page.reload();

  await expect(page.getByTestId("add-shape")).toBeVisible();
  await expectShapeCount(page, 2);
  expect((await sceneState(page)).shapes.map((shape) => shape.kind)).toEqual(["box", "cylinder"]);
  expect(page.url()).toBe(projectUrl);
});

test("keeps an edit made after the first save", async ({ page }) => {
  await createProject(page);
  await addShape(page, "box");
  await page.waitForTimeout(1500);

  await tool(page, "duplicate").click();
  await expectShapeCount(page, 2);
  await page.waitForTimeout(1500);

  await page.reload();
  await expect(page.getByTestId("add-shape")).toBeVisible();
  await expectShapeCount(page, 2);
});

test("lists the new project on the dashboard", async ({ page }) => {
  await createProject(page);
  await addShape(page, "box");
  await page.waitForTimeout(1500);

  await page.goto("/");
  await expect(page.locator(".project-card").first()).toBeVisible();
});

test("starts a scratch editor with no project when opened directly", async ({ page }) => {
  await page.goto("/?editor=1");
  await expect(page.getByTestId("add-shape")).toBeVisible();
  await expectShapeCount(page, 0);
  expect(page.url()).not.toMatch(/project=/);
});
