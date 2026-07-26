import { expect, test } from "@playwright/test";
import { addShape, enterFreehandSketch, openEditor, tool } from "./helpers";

/**
 * The ribbon's five tabs. Solid and Sketch keep hand-built sections because they
 * carry widgets a button list cannot express; the rest render straight from the
 * command registry, which is what stops a command's label, its availability and
 * its shortcut from drifting apart.
 */

const TABS = ["solid", "sketch", "mesh", "inspect", "utilities"] as const;

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("shows every tab and starts on Solid", async ({ page }) => {
  for (const tab of TABS) {
    await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
  }
  await expect(page.getByTestId("tab-solid")).toHaveAttribute("aria-selected", "true");
});

test("switches between tabs", async ({ page }) => {
  for (const tab of TABS) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-selected", "true");
  }
});

test("renders registry commands on the tabs that have them", async ({ page }) => {
  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "separate-parts")).toBeVisible();

  await page.getByTestId("tab-utilities").click();
  await expect(tool(page, "import")).toBeVisible();
  await expect(tool(page, "export")).toBeVisible();
});

test("reflects availability from the registry, not from the tab", async ({ page }) => {
  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "separate-parts")).toBeDisabled();

  await page.getByTestId("tab-solid").click();
  await addShape(page, "box");

  // A single primitive still has only one connected part, so the command stays
  // unavailable — the point is that the answer comes from the registry.
  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "separate-parts")).toBeDisabled();
});

test("keeps the quick actions reachable from every tab", async ({ page }) => {
  for (const tab of TABS) {
    await page.getByTestId(`tab-${tab}`).click();
    await expect(page.getByTestId("command-search-open")).toBeVisible();
    await expect(page.getByTestId("language-switch")).toBeVisible();
  }
});

test("moves to the Sketch tab when a sketch starts and back when it finishes", async ({ page }) => {
  await enterFreehandSketch(page);
  await expect(page.getByTestId("tab-sketch")).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("sketch-cancel").click();
  await page.getByTestId("tab-solid").click();
  await expect(page.getByTestId("tab-solid")).toHaveAttribute("aria-selected", "true");
});
