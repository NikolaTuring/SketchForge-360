import { expect, test, type Page } from "@playwright/test";
import { openEditor } from "./helpers";

/**
 * Light and dark.
 *
 * The interface named 346 distinct colours by hand before this; they are now
 * seven roles plus a set of accents. What is worth asserting is that the roles
 * actually flip, that the 3D canvas flips with them — a white canvas inside a
 * dark interface is the single most jarring part of a half-themed editor — and
 * that the choice survives a reload.
 */

async function token(page: Page, name: string) {
  return page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name);
}

/** The 3D canvas's clear colour, read back from the rendered pixels. */
async function canvasCorner(page: Page) {
  return page.locator(".workplane-stage canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) throw new Error("no WebGL context");
    const pixel = new Uint8Array(4);
    // Top-left of the framebuffer: above the workplane, so it is background.
    context.readPixels(4, canvas.height - 4, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
    return pixel[0] + pixel[1] + pixel[2];
  });
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("starts on the system setting", async ({ page }) => {
  await expect(page.getByTestId("theme-switch")).toHaveValue("system");
  // System is recorded by the *absence* of the attribute, so the stylesheet's
  // own media query is what decides. Writing a resolved value here would freeze
  // a machine that switches at dusk into whatever it was at that moment.
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-theme"))).toBe(false);
});

test("switches the interface to dark and back", async ({ page }) => {
  const lightSurface = await token(page, "--sf-surface");

  await page.getByTestId("theme-switch").selectOption("dark");
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
  const darkSurface = await token(page, "--sf-surface");
  expect(darkSurface).not.toBe(lightSurface);

  await page.getByTestId("theme-switch").selectOption("light");
  expect(await token(page, "--sf-surface")).toBe(lightSurface);
});

test("text and surface swap places rather than both darkening", async ({ page }) => {
  const brightness = (value: string) => {
    const [r, g, b] = (value.match(/\w\w/g) ?? []).map((part) => Number.parseInt(part, 16));
    return r + g + b;
  };

  const lightPair = { surface: await token(page, "--sf-surface"), text: await token(page, "--sf-text-strong") };
  await page.getByTestId("theme-switch").selectOption("dark");
  const darkPair = { surface: await token(page, "--sf-surface"), text: await token(page, "--sf-text-strong") };

  // Contrast has to survive the flip in both directions, or something is
  // unreadable in one of the two themes.
  expect(brightness(lightPair.surface)).toBeGreaterThan(brightness(lightPair.text));
  expect(brightness(darkPair.surface)).toBeLessThan(brightness(darkPair.text));
});

test("the 3D canvas follows the theme", async ({ page }) => {
  const light = await canvasCorner(page);
  await page.getByTestId("theme-switch").selectOption("dark");
  await expect.poll(() => canvasCorner(page)).toBeLessThan(light - 100);
});

test("remembers the choice across a reload", async ({ page }) => {
  await page.getByTestId("theme-switch").selectOption("dark");
  await page.reload();
  await expect(page.getByTestId("add-shape")).toBeVisible();

  await expect(page.getByTestId("theme-switch")).toHaveValue("dark");
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
});

test("the panels follow the theme, not just the page", async ({ page }) => {
  await page.getByTestId("theme-switch").selectOption("dark");

  const backgrounds = await page.evaluate(() =>
    [".secondary-toolbar", "[data-testid='model-browser']", "[data-testid='status-bar']", ".camera-controls"].map((selector) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node).backgroundColor : "missing";
    }),
  );

  // Every one of these was a hand-written light colour before the tokens.
  backgrounds.forEach((value) => {
    const [r, g, b] = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    expect(r + g + b).toBeLessThan(240);
  });
});

test("is named in both languages", async ({ page }) => {
  await expect(page.getByTestId("theme-switch")).toHaveAttribute("aria-label", "Theme");
  await page.getByTestId("language-switch").selectOption("de");
  await expect(page.getByTestId("theme-switch")).toHaveAttribute("aria-label", "Darstellung");
});
