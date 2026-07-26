import { describe, expect, it } from "vitest";

import { expandIndexedMesh, workplaneShapeFromFeatureBody } from "@/lib/parametricBody";
import type { BrepFeatureBody } from "@/lib/brepFeatureTypes";

/**
 * Placing a kernel-built body in the scene.
 *
 * The kernel works in world millimetres; a scene body carries geometry in its
 * own local frame plus a placement. Getting that wrong does not error — it puts
 * the body somewhere else, or lying on its side — which is exactly the kind of
 * failure that survives a whole session before anyone notices.
 */

function body(overrides: Partial<BrepFeatureBody> = {}): BrepFeatureBody {
  // A unit box spanning x 10..50, y 5..17, z -20..10.
  const corners = [
    [10, 5, -20], [50, 5, -20], [50, 17, -20], [10, 17, -20],
    [10, 5, 10], [50, 5, 10], [50, 17, 10], [10, 17, 10],
  ];
  const positions = new Float32Array(corners.flat());
  return {
    positions,
    normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    triangleCount: 4,
    brep: "CASCADE Topology V3",
    stepText: "ISO-10303-21;",
    displayEdges: [{ points: [10, 5, -20, 50, 5, -20] }],
    volume: 40 * 12 * 30,
    bounds: { width: 40, depth: 30, height: 12, center: { x: 30, y: 11, z: -5 } },
    ...overrides,
  };
}

describe("expanding an indexed mesh", () => {
  it("writes three vertices per triangle", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const soup = expandIndexedMesh(positions, new Uint32Array([0, 1, 2, 2, 1, 0]));
    expect(soup).toHaveLength(18);
    expect(soup.slice(0, 9)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // The second triangle names the same vertices in reverse, and each is
    // written out again — a shared index would make it invisible to every
    // consumer that counts nine numbers per triangle.
    expect(soup.slice(9)).toEqual([0, 1, 0, 1, 0, 0, 0, 0, 0]);
  });
});

describe("scene placement", () => {
  it("takes its size from the bounds", () => {
    const shape = workplaneShapeFromFeatureBody(body(), { id: "b", name: "Body" });
    expect(shape.width).toBeCloseTo(40, 6);
    expect(shape.depth).toBeCloseTo(30, 6);
    expect(shape.height).toBeCloseTo(12, 6);
  });

  it("places the body where the kernel built it", () => {
    const shape = workplaneShapeFromFeatureBody(body(), { id: "b", name: "Body" });
    expect(shape.x).toBeCloseTo(30, 6);
    expect(shape.z).toBeCloseTo(-5, 6);
    // Elevation is the *bottom* of the body, not its centre: a body sitting on
    // the workplane has elevation zero, and using the centre would sink every
    // body half its own height into the plane.
    expect(shape.elevation).toBeCloseTo(5, 6);
  });

  it("moves the mesh into a local frame centred in x and z, starting at y zero", () => {
    const shape = workplaneShapeFromFeatureBody(body(), { id: "b", name: "Body" });
    const positions = shape.importedMesh?.positions ?? [];
    const xs = positions.filter((_, index) => index % 3 === 0);
    const ys = positions.filter((_, index) => index % 3 === 1);
    const zs = positions.filter((_, index) => index % 3 === 2);

    expect(Math.min(...xs)).toBeCloseTo(-20, 6);
    expect(Math.max(...xs)).toBeCloseTo(20, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(Math.max(...ys)).toBeCloseTo(12, 6);
    expect(Math.min(...zs)).toBeCloseTo(-15, 6);
    expect(Math.max(...zs)).toBeCloseTo(15, 6);
  });

  it("moves the display edges with the mesh", () => {
    // Edges drawn in world coordinates over a body drawn in local ones would
    // float beside it — visible, wrong, and easy to mistake for a modelling
    // error rather than a placement bug.
    const shape = workplaneShapeFromFeatureBody(body(), { id: "b", name: "Body" });
    expect(shape.cadDisplayEdges?.[0].points.slice(0, 3)).toEqual([-20, 0, -15]);
  });

  it("carries both serialisations so the body stays exact", () => {
    const shape = workplaneShapeFromFeatureBody(body(), { id: "b", name: "Body" });
    expect(shape.cadBrep).toContain("CASCADE");
    expect(shape.importedMesh?.brepStep).toContain("ISO-10303-21");
    expect(shape.cadBrepFrame).toEqual({ x: 30, z: -5, elevation: 5, width: 40, depth: 30, height: 12 });
  });

  it("keeps an existing body's identity when it is rebuilt", () => {
    const existing = { id: "old", name: "Bracket", color: "#123456", locked: true, hidden: true } as never;
    const shape = workplaneShapeFromFeatureBody(body(), { id: "old", name: "Bracket", existing });
    expect(shape.color).toBe("#123456");
    expect(shape.locked).toBe(true);
    expect(shape.hidden).toBe(true);
  });

  it("never reports a zero dimension", () => {
    // A flat profile extruded by nothing would otherwise produce a body the
    // viewport cannot scale and the inspector cannot edit.
    const flat = body({ bounds: { width: 0, depth: 0, height: 0, center: { x: 0, y: 0, z: 0 } } });
    const shape = workplaneShapeFromFeatureBody(flat, { id: "b", name: "Body" });
    expect(shape.width).toBeGreaterThan(0);
    expect(shape.depth).toBeGreaterThan(0);
    expect(shape.height).toBeGreaterThan(0);
  });

  it("preserves edge features across a resize", () => {
    // A sketch body's size comes from its profile, so a resize must not rescale
    // the fillets applied to it.
    expect(workplaneShapeFromFeatureBody(body(), { id: "b", name: "Body" }).edgeResizeMode).toBe("preserve");
  });
});
