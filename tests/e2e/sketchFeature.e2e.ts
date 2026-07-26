import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { OcctKernel as OcctKernelType, ShapeHandle } from "occt-wasm";
import {
  applyFeatureOperation,
  extrudeRegions,
  revolveRegions,
  type SketchFeatureKernel,
} from "@/lib/brepSketchFeatures";
import { findSketchRegions } from "@/lib/sketchProfiles";
import { createCircle, rectangleEntities, sketchFrame, vec2 } from "@/lib/sketchEntities";
import { solveSketch } from "@/lib/sketchSolver";
import type { Sketch, SketchConstraint, SketchEntity, SketchPointRef } from "@/types/sketch";

// Drives the real feature builders against the real OpenCascade kernel loaded
// from node_modules, rather than the browser-only /occt/ URL.
let kernel: OcctKernelType;

beforeAll(async () => {
  const { OcctKernel } = await import("occt-wasm");
  const wasm = join(dirname(fileURLToPath(import.meta.resolve("occt-wasm"))), "occt-wasm.wasm");
  kernel = await OcctKernel.init({ wasm });
}, 120_000);

const GROUND_PLANE = sketchFrame({ kind: "base", plane: "xz", offset: 0 });

let counter = 0;
function id() {
  counter += 1;
  return `e2e-${counter}`;
}

function ref(entityId: string, role: SketchPointRef["role"]): SketchPointRef {
  return { entityId, role };
}

function dimension(value: number) {
  return { expression: String(value), value };
}

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return { id: "s", name: "Sketch", plane: { kind: "base", plane: "xz", offset: 0 }, entities, constraints };
}

function faceSurfaceTypes(shape: ShapeHandle) {
  const faces = kernel.getSubShapes(shape, "face");
  try {
    return faces.map((face) => kernel.surfaceType(face));
  } finally {
    faces.forEach((face) => kernel.release(face));
  }
}

function countTypes(types: string[]) {
  return types.reduce<Record<string, number>>((totals, type) => {
    totals[type] = (totals[type] ?? 0) + 1;
    return totals;
  }, {});
}

describe("sketch features against the real kernel", () => {
  it("extrudes a constrained rectangle into an exact box", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const [bottom, right] = entities;

    const solved = solveSketch(
      sketchOf(entities, [
        ...constraints,
        { id: id(), type: "fix", point: ref(bottom.id, "start"), at: vec2(0, 0) },
        { id: id(), type: "distance", a: ref(bottom.id, "start"), b: ref(bottom.id, "end"), value: dimension(40) },
        { id: id(), type: "distance", a: ref(right.id, "start"), b: ref(right.id, "end"), value: dimension(30) },
      ]),
    );
    expect(solved.status).toBe("solved");
    expect(solved.degreesOfFreedom).toBe(0);

    const { regions, issues } = findSketchRegions(solved.entities);
    expect(issues).toHaveLength(0);
    expect(regions).toHaveLength(1);

    const result = extrudeRegions(kernel as SketchFeatureKernel, GROUND_PLANE, regions, solved.entities, { distance: 10 });
    try {
      expect(kernel.isSolid(result.shape)).toBe(true);
      expect(result.volume).toBeCloseTo(40 * 30 * 10, 3);
      // Six planar faces and nothing else: the analytic path did not fall back
      // to a tessellated approximation.
      expect(countTypes(faceSurfaceTypes(result.shape))).toEqual({ plane: 6 });
    } finally {
      kernel.release(result.shape);
    }
  }, 120_000);

  it("extrudes a profile with a circular hole into a real cylindrical face", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(40, 30));
    const hole = createCircle(vec2(20, 15), 5);

    const solved = solveSketch(
      sketchOf([...entities, hole], [
        ...constraints,
        { id: id(), type: "diameter", entity: hole.id, value: dimension(10) },
      ] as SketchConstraint[]),
    );
    expect(solved.residualNorm).toBeLessThan(1e-6);

    const { regions } = findSketchRegions(solved.entities);
    expect(regions).toHaveLength(1);
    expect(regions[0].innerLoops).toHaveLength(1);

    const result = extrudeRegions(kernel as SketchFeatureKernel, GROUND_PLANE, regions, solved.entities, { distance: 10 });
    try {
      expect(kernel.isSolid(result.shape)).toBe(true);
      expect(result.volume).toBeCloseTo((40 * 30 - Math.PI * 25) * 10, 2);
      // The hole must be one cylinder, not a ring of narrow planes.
      expect(countTypes(faceSurfaceTypes(result.shape))).toEqual({ plane: 6, cylinder: 1 });
    } finally {
      kernel.release(result.shape);
    }
  }, 120_000);

  it("extrudes symmetrically about the sketch plane", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const solved = solveSketch(sketchOf(entities, constraints));
    const { regions } = findSketchRegions(solved.entities);

    const result = extrudeRegions(kernel as SketchFeatureKernel, GROUND_PLANE, regions, solved.entities, {
      distance: 12,
      mode: "symmetric",
    });
    try {
      expect(result.volume).toBeCloseTo(20 * 10 * 12, 3);
      const box = kernel.getBoundingBox(result.shape);
      // The ground plane is XZ, so a symmetric extrude straddles y = 0.
      expect(box.ymin).toBeCloseTo(-6, 4);
      expect(box.ymax).toBeCloseTo(6, 4);
    } finally {
      kernel.release(result.shape);
    }
  }, 120_000);

  it("revolves a profile into an exact annular body", () => {
    const { entities, constraints } = rectangleEntities(vec2(10, 0), vec2(20, 5));
    const solved = solveSketch(sketchOf(entities, constraints));
    const { regions } = findSketchRegions(solved.entities);

    const result = revolveRegions(kernel as SketchFeatureKernel, GROUND_PLANE, regions, solved.entities, {
      axisPoint: { x: 0, y: 0 },
      axisDirection: { x: 0, y: 1 },
      angle: 360,
    });
    try {
      expect(kernel.isSolid(result.shape)).toBe(true);
      expect(result.volume).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 5, 2);
      const types = countTypes(faceSurfaceTypes(result.shape));
      expect(types.cylinder).toBe(2);
      expect(types.plane).toBe(2);
    } finally {
      kernel.release(result.shape);
    }
  }, 120_000);

  it("cuts a pocket out of an existing body", () => {
    const target = kernel.makeBox(40, 10, 30);
    // The box spans x 0..40, y 0..30 upward and z 0..30. Ground-plane sketch v
    // runs opposite to world z, so the pocket profile uses negative v to land
    // inside the box footprint, and the +Y normal drives it down into the top.
    const pocketProfile = rectangleEntities(vec2(5, -15), vec2(15, -5)).entities;
    const pocket = extrudeRegions(
      kernel as SketchFeatureKernel,
      GROUND_PLANE,
      findSketchRegions(pocketProfile).regions,
      pocketProfile,
      { distance: 4 },
    );

    const combined = applyFeatureOperation(kernel as SketchFeatureKernel, "cut", pocket.shape, [target]);
    try {
      expect(kernel.isValid(combined)).toBe(true);
      // The pocket sits inside the box footprint, so the cut removes its volume.
      expect(kernel.getVolume(combined)).toBeCloseTo(40 * 10 * 30 - 10 * 10 * 4, 2);
    } finally {
      kernel.release(combined);
    }
  }, 120_000);

  it("round-trips an extruded sketch body through STEP", async () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(25, 15));
    const solved = solveSketch(sketchOf(entities, constraints));
    const { regions } = findSketchRegions(solved.entities);
    const result = extrudeRegions(kernel as SketchFeatureKernel, GROUND_PLANE, regions, solved.entities, { distance: 8 });

    try {
      const step = kernel.exportStep(result.shape);
      expect(step).toMatch(/ISO-10303-21/);

      const reimported = kernel.importStep(step);
      try {
        expect(kernel.getVolume(reimported)).toBeCloseTo(result.volume, 3);
      } finally {
        kernel.release(reimported);
      }
    } finally {
      kernel.release(result.shape);
    }
  }, 120_000);

  it("reports a helpful error instead of building an empty body", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const solved = solveSketch(sketchOf(entities, constraints));
    const { regions } = findSketchRegions(solved.entities);

    expect(() =>
      extrudeRegions(kernel as SketchFeatureKernel, GROUND_PLANE, regions, solved.entities, { distance: 0 }),
    ).toThrow(/greater than zero/);

    expect(() =>
      extrudeRegions(kernel as SketchFeatureKernel, GROUND_PLANE, [], solved.entities, { distance: 5 }),
    ).toThrow(/at least one closed profile/);
  }, 120_000);
});
