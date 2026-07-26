import { expect, test } from "@playwright/test";
import { addShape, expectShapeCount, openEditor, sceneState, tool } from "./helpers";

/**
 * Recognising the surfaces of an imported mesh.
 *
 * This is the first half of the answer to "an STL is not just triangles": before
 * anything is rebuilt, the editor says what the mesh is actually made of. The
 * test drives the whole path — file input, import, worker, notice — because the
 * pieces are individually tested elsewhere and it is the seams that break.
 */

/** An ASCII STL of an axis-aligned box, written out facet by facet. */
function boxStl(width: number, height: number, depth: number): string {
  const corners = [
    [0, 0, 0], [width, 0, 0], [width, height, 0], [0, height, 0],
    [0, 0, depth], [width, 0, depth], [width, height, depth], [0, height, depth],
  ];
  const faces: [number[], number[]][] = [
    [[0, 3, 2], [0, 2, 1]], // z = 0
    [[4, 5, 6], [4, 6, 7]], // z = depth
    [[0, 1, 5], [0, 5, 4]], // y = 0
    [[3, 7, 6], [3, 6, 2]], // y = height
    [[0, 4, 7], [0, 7, 3]], // x = 0
    [[1, 2, 6], [1, 6, 5]], // x = width
  ];

  const facets = faces
    .flat()
    .map((triangle) => {
      const points = triangle.map((index) => corners[index]);
      // The normal is recomputed by the importer, so a zero here is harmless
      // and keeps the fixture readable.
      const vertices = points.map(([x, y, z]) => `      vertex ${x} ${y} ${z}`).join("\n");
      return `  facet normal 0 0 0\n    outer loop\n${vertices}\n    endloop\n  endfacet`;
    })
    .join("\n");

  return `solid box\n${facets}\nendsolid box\n`;
}

async function importBox(page: import("@playwright/test").Page) {
  await page.getByTestId("import-file-input").setInputFiles({
    name: "block.stl",
    mimeType: "model/stl",
    buffer: Buffer.from(boxStl(40, 10, 30), "utf8"),
  });
  await expectShapeCount(page, 1);
  const state = await sceneState(page);
  expect(state.shapes[0].importedTriangles).toBe(12);
  return state.shapes[0];
}

test.beforeEach(async ({ page }) => {
  await openEditor(page);
});

test("the command is unavailable without an imported mesh", async ({ page }) => {
  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "analyze-mesh")).toBeDisabled();

  // A modelled primitive is not an imported mesh; there is nothing to recover.
  await page.getByTestId("tab-solid").click();
  await addShape(page, "box");
  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "analyze-mesh")).toBeDisabled();
});

test("recognises the six planes of an imported box", async ({ page }) => {
  await importBox(page);

  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "analyze-mesh")).toBeEnabled();
  await tool(page, "analyze-mesh").click();

  // The worker loads a 22 MB kernel on some paths, so this is given room.
  await expect
    .poll(async () => (await sceneState(page)).notice, { timeout: 60_000 })
    .toMatch(/6 planes/);

  const notice = (await sceneState(page)).notice;
  // Honest reporting: how much of the surface was actually accounted for.
  expect(notice).toMatch(/100% of the surface/);
  expect(notice).not.toMatch(/not closed/);
});

test("reports in the chosen language", async ({ page }) => {
  await page.getByTestId("language-switch").selectOption("de");
  await importBox(page);

  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "analyze-mesh")).toHaveAttribute("aria-label", "Flächen erkennen");
});

test("only offers the command for a single selection", async ({ page }) => {
  await importBox(page);
  await addShape(page, "box");
  await page.locator("body").click({ position: { x: 5, y: 400 } });
  await page.keyboard.press("Control+a");

  // Two bodies selected: surface recognition answers a question about one, so
  // guessing which is worse than saying it does not apply.
  await page.getByTestId("tab-mesh").click();
  await expect(tool(page, "analyze-mesh")).toBeDisabled();
});
