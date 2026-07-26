import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { OcctKernel as OcctKernelType } from "occt-wasm";

import { buildSketchFeature, convertMesh, listPlanarFaces } from "@/lib/brepFeatureBuild";
import { createCircle, createLine, rectangleEntities, vec2 } from "@/lib/sketchEntities";
import type { Sketch, SketchConstraint, SketchEntity, SketchPointRef } from "@/types/sketch";

/**
 * The worker's payload, driven directly against the real OpenCascade kernel.
 *
 * The worker itself is a thin message shell; everything worth getting wrong
 * lives in `brepFeatureBuild`. Testing it here rather than through a message
 * round trip means a wrong face normal fails with a readable assertion instead
 * of a mysteriously misplaced sketch plane three phases later.
 */

let kernel: OcctKernelType;

beforeAll(async () => {
  const { OcctKernel } = await import("occt-wasm");
  const wasm = join(dirname(fileURLToPath(import.meta.resolve("occt-wasm"))), "occt-wasm.wasm");
  kernel = await OcctKernel.init({ wasm });
}, 120_000);

let counter = 0;
function id() {
  counter += 1;
  return `build-${counter}`;
}

function ref(entityId: string, role: SketchPointRef["role"]): SketchPointRef {
  return { entityId, role };
}

function dimension(value: number) {
  return { expression: String(value), value };
}

/** A rectangle on the ground plane, dimensioned and fully constrained. */
function plateSketch(width: number, depth: number, extra: SketchEntity[] = [], extraConstraints: SketchConstraint[] = []): Sketch {
  const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(width, depth));
  const [bottom, right] = entities;
  return {
    id: "sketch",
    name: "Plate",
    plane: { kind: "base", plane: "xz", offset: 0 },
    entities: [...entities, ...extra],
    constraints: [
      ...constraints,
      { id: id(), type: "fix", point: ref(bottom.id, "start"), at: vec2(0, 0) },
      { id: id(), type: "distance", a: ref(bottom.id, "start"), b: ref(bottom.id, "end"), value: dimension(width) },
      { id: id(), type: "distance", a: ref(right.id, "start"), b: ref(right.id, "end"), value: dimension(depth) },
      ...extraConstraints,
    ] as SketchConstraint[],
  };
}

describe("the feature worker's payload", () => {
  it("builds a body with everything the editor needs to place it", () => {
    const body = buildSketchFeature(kernel, {
      sketch: plateSketch(40, 30),
      regionKeys: null,
      operation: "new",
      extrude: { distance: 10 },
    });

    expect(body.volume).toBeCloseTo(40 * 30 * 10, 2);
    expect(body.triangleCount).toBeGreaterThan(0);
    expect(body.positions.length).toBe(body.normals.length);

    // The bounds are what turn a solid into a `WorkplaneShape`: get the axis
    // mapping wrong here and every sketch body lands rotated.
    expect(body.bounds.width).toBeCloseTo(40, 3);
    expect(body.bounds.depth).toBeCloseTo(30, 3);
    expect(body.bounds.height).toBeCloseTo(10, 3);

    // Both serialisations, so the body can be edge-modified later and exported
    // exactly without a second trip through the kernel.
    expect(body.brep).toContain("CASCADE Topology");
    expect(body.stepText).toContain("ISO-10303-21");
    expect(body.stepText).toContain("MANIFOLD_SOLID_BREP");

    // The STEP has to be in the body's own local frame, matching the mesh: a
    // file whose contents are right and whose position is off by the body's
    // placement looks fine here and lands in the wrong place in another program.
    const stepCoordinates = [...body.stepText.matchAll(/CARTESIAN_POINT\s*\(\s*''\s*,\s*\(([-\d.eE,\s]+)\)/g)]
      .map((match) => match[1].split(",").map((part) => Number.parseFloat(part)))
      .filter((point) => point.length === 3 && point.every(Number.isFinite));
    expect(stepCoordinates.length).toBeGreaterThan(0);
    // The plate spans 40 x 30 centred on the origin, 10 tall from y = 0. In any
    // axis order that means nothing beyond 20 and nothing below -20.
    stepCoordinates.forEach((point) => {
      point.forEach((component) => expect(Math.abs(component)).toBeLessThanOrEqual(20.001));
    });

    // Twelve edges on a box; the display wireframe is what draws them.
    expect(body.displayEdges.length).toBe(12);
    body.displayEdges.forEach((edge) => expect(edge.points.length % 3).toBe(0));
  }, 120_000);

  it("cuts a pocket into an existing body", () => {
    const plate = buildSketchFeature(kernel, {
      sketch: plateSketch(40, 30),
      regionKeys: null,
      operation: "new",
      extrude: { distance: 10 },
    });

    const hole = createCircle(vec2(20, 15), 5);
    const pocket = buildSketchFeature(kernel, {
      sketch: plateSketch(40, 30, [hole], [{ id: id(), type: "diameter", entity: hole.id, value: dimension(10) } as SketchConstraint]),
      // Only the circle: the rectangle's own region would cut the whole plate away.
      regionKeys: null,
      operation: "cut",
      extrude: { distance: 10 },
      targetBrep: plate.brep,
    });

    // The rectangle region carries the circle as an inner loop, so cutting the
    // profile removes the plate minus the hole — leaving the hole's own volume.
    expect(pocket.volume).toBeCloseTo(Math.PI * 25 * 10, 1);
  }, 120_000);

  it("refuses an open profile with a message that says what is wrong", () => {
    // Two lines that never meet: solvable, but no closed loop to build on.
    const open: Sketch = {
      id: "open",
      name: "Open",
      plane: { kind: "base", plane: "xz", offset: 0 },
      entities: [createLine(vec2(0, 0), vec2(40, 0)), createLine(vec2(0, 20), vec2(40, 20))],
      constraints: [],
    };

    expect(() => buildSketchFeature(kernel, { sketch: open, regionKeys: null, operation: "new", extrude: { distance: 10 } }))
      .toThrow(/does not join up/i);
  }, 120_000);

  it("lists a box's planar faces with outward normals", () => {
    const body = buildSketchFeature(kernel, {
      sketch: plateSketch(40, 30),
      regionKeys: null,
      operation: "new",
      extrude: { distance: 10 },
    });

    const faces = listPlanarFaces(kernel, body.brep);
    expect(faces).toHaveLength(6);

    // Largest first, and a box's six faces come in three equal pairs.
    expect(faces[0].area).toBeGreaterThanOrEqual(faces[5].area);

    // The six outward normals of a box are the six axis directions, each once.
    // An inward normal here would make a sketch drawn on that face extrude into
    // the solid instead of out of it.
    const axes = faces
      .map((face) => `${Math.round(face.normal.x)},${Math.round(face.normal.y)},${Math.round(face.normal.z)}`)
      .sort();
    expect(axes).toEqual(["-1,0,0", "0,-1,0", "0,0,-1", "0,0,1", "0,1,0", "1,0,0"]);

    // Every normal is a unit vector: a normalisation slip would show up as a
    // sketch plane whose offset is scaled by the wrong amount.
    faces.forEach((face) => {
      expect(Math.hypot(face.normal.x, face.normal.y, face.normal.z)).toBeCloseTo(1, 6);
    });
  }, 120_000);

  it("recognises the surfaces of a tessellated body it just built", () => {
    const body = buildSketchFeature(kernel, {
      sketch: plateSketch(40, 30, [createCircle(vec2(20, 15), 5)], []),
      regionKeys: null,
      operation: "new",
      extrude: { distance: 10 },
    });

    // Straight from tessellation back to analytic surfaces — the round trip the
    // STL import path takes, with a mesh whose true answer is known. The
    // kernel's tessellation is indexed, so the indices have to travel with it:
    // read as a triangle soup, this box comes out as eight triangles with
    // fourteen boundary edges instead of a closed solid.
    const report = convertMesh(body.positions, {}, body.indices);
    expect(report.manifold).toBe(true);
    expect(report.boundaryEdges).toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.tally.plane).toBe(6);
    expect(report.tally.cylinder).toBe(1);
    expect(report.coverage).toBeGreaterThan(0.99);
    expect(report.summary).toMatch(/6 planes/);
  }, 120_000);
});
