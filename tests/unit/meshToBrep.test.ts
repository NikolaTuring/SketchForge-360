import { describe, expect, it } from "vitest";
import {
  analyzeMeshForConversion,
  buildMeshTopology,
  describeConversion,
  fitCone,
  fitCylinder,
  fitPlane,
  fitSphere,
  isManifold,
  regularizeSegments,
  segmentMesh,
  symmetricEigen3,
  type FitSample,
  type MeshSegment,
} from "@/lib/meshToBrep";

// ---------------------------------------------------------------------------
// Synthetic meshes, built the way an STL exporter would
// ---------------------------------------------------------------------------

type Point = [number, number, number];

function pushTriangle(target: number[], a: Point, b: Point, c: Point) {
  target.push(...a, ...b, ...c);
}

function boxMesh(width: number, height: number, depth: number): number[] {
  const x = width / 2;
  const y = height / 2;
  const z = depth / 2;
  const corner = (sx: number, sy: number, sz: number): Point => [sx * x, sy * y, sz * z];
  const quad = (a: Point, b: Point, c: Point, d: Point, out: number[]) => {
    pushTriangle(out, a, b, c);
    pushTriangle(out, a, c, d);
  };

  const out: number[] = [];
  quad(corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1), out); // +Z
  quad(corner(1, -1, -1), corner(-1, -1, -1), corner(-1, 1, -1), corner(1, 1, -1), out); // -Z
  quad(corner(1, -1, 1), corner(1, -1, -1), corner(1, 1, -1), corner(1, 1, 1), out); // +X
  quad(corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1), out); // -X
  quad(corner(-1, 1, 1), corner(1, 1, 1), corner(1, 1, -1), corner(-1, 1, -1), out); // +Y
  quad(corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1), out); // -Y
  return out;
}

function cylinderMesh(radius: number, height: number, sides: number): number[] {
  const out: number[] = [];
  const at = (index: number, y: number): Point => {
    const angle = (index / sides) * Math.PI * 2;
    return [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  };

  for (let index = 0; index < sides; index += 1) {
    const next = index + 1;
    pushTriangle(out, at(index, 0), at(next, 0), at(next, height));
    pushTriangle(out, at(index, 0), at(next, height), at(index, height));
    // Caps as triangle fans.
    pushTriangle(out, [0, height, 0], at(index, height), at(next, height));
    pushTriangle(out, [0, 0, 0], at(next, 0), at(index, 0));
  }
  return out;
}

function sphereMesh(radius: number, longitudes: number, latitudes: number): number[] {
  const out: number[] = [];
  const at = (lon: number, lat: number): Point => {
    const theta = (lat / latitudes) * Math.PI;
    const phi = (lon / longitudes) * Math.PI * 2;
    return [
      Math.sin(theta) * Math.cos(phi) * radius,
      Math.cos(theta) * radius,
      Math.sin(theta) * Math.sin(phi) * radius,
    ];
  };

  for (let lat = 0; lat < latitudes; lat += 1) {
    for (let lon = 0; lon < longitudes; lon += 1) {
      const a = at(lon, lat);
      const b = at(lon + 1, lat);
      const c = at(lon + 1, lat + 1);
      const d = at(lon, lat + 1);
      if (lat > 0) pushTriangle(out, a, b, c);
      if (lat < latitudes - 1) pushTriangle(out, a, c, d);
    }
  }
  return out;
}

function coneMesh(radius: number, height: number, sides: number): number[] {
  const out: number[] = [];
  const at = (index: number): Point => {
    const angle = (index / sides) * Math.PI * 2;
    return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
  };
  const apex: Point = [0, height, 0];

  for (let index = 0; index < sides; index += 1) {
    pushTriangle(out, at(index), at(index + 1), apex);
    pushTriangle(out, [0, 0, 0], at(index + 1), at(index));
  }
  return out;
}

function samplesOnCylinder(radius: number, height: number, sides: number, axis: "x" | "y" = "y"): FitSample[] {
  const samples: FitSample[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (index / sides) * Math.PI * 2;
    for (const t of [0, 0.5, 1]) {
      const around = { c: Math.cos(angle) * radius, s: Math.sin(angle) * radius };
      const along = t * height;
      const point = axis === "y" ? { x: around.c, y: along, z: around.s } : { x: along, y: around.c, z: around.s };
      const normal = axis === "y"
        ? { x: Math.cos(angle), y: 0, z: Math.sin(angle) }
        : { x: 0, y: Math.cos(angle), z: Math.sin(angle) };
      samples.push({ point, normal, weight: 1 });
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------

describe("buildMeshTopology", () => {
  it("welds a non-indexed box into eight shared vertices", () => {
    const topology = buildMeshTopology(boxMesh(10, 10, 10));
    expect(topology.vertexCount).toBe(8);
    expect(topology.triangleCount).toBe(12);
    expect(topology.nonManifoldEdgeCount).toBe(0);
    expect(isManifold(topology)).toBe(true);
  });

  it("gives every triangle three neighbours on a closed mesh", () => {
    const topology = buildMeshTopology(cylinderMesh(10, 20, 24));
    expect(topology.adjacency.every((neighbour) => neighbour >= 0)).toBe(true);
  });

  it("reports an open mesh as non-manifold", () => {
    // A single triangle has three boundary edges.
    const topology = buildMeshTopology([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect(topology.triangleCount).toBe(1);
    expect(isManifold(topology)).toBe(false);
  });

  it("drops degenerate triangles that welding collapses", () => {
    const positions = [...boxMesh(10, 10, 10), 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(buildMeshTopology(positions).triangleCount).toBe(12);
  });

  it("computes unit normals and correct areas", () => {
    const topology = buildMeshTopology([0, 0, 0, 6, 0, 0, 0, 8, 0]);
    expect(topology.areas[0]).toBeCloseTo(24, 9);
    expect(Math.hypot(topology.normals[0], topology.normals[1], topology.normals[2])).toBeCloseTo(1, 12);
  });
});

describe("symmetricEigen3", () => {
  it("recovers eigenvalues in ascending order", () => {
    // Diagonal matrix with entries 5, 1, 3.
    const { values, vectors } = symmetricEigen3([5, 0, 0, 1, 0, 3]);
    expect(values[0]).toBeCloseTo(1, 10);
    expect(values[2]).toBeCloseTo(5, 10);
    expect(Math.abs(vectors[0].y)).toBeCloseTo(1, 10);
  });

  it("stays accurate when two eigenvalues are equal", () => {
    const { values } = symmetricEigen3([2, 0, 0, 2, 0, 7]);
    expect(values[0]).toBeCloseTo(2, 10);
    expect(values[1]).toBeCloseTo(2, 10);
    expect(values[2]).toBeCloseTo(7, 10);
  });
});

describe("surface fitting", () => {
  it("fits a plane through coplanar samples and orients it with the mesh", () => {
    const samples: FitSample[] = [
      { point: { x: 0, y: 5, z: 0 }, normal: { x: 0, y: 1, z: 0 }, weight: 1 },
      { point: { x: 10, y: 5, z: 0 }, normal: { x: 0, y: 1, z: 0 }, weight: 1 },
      { point: { x: 0, y: 5, z: 10 }, normal: { x: 0, y: 1, z: 0 }, weight: 1 },
      { point: { x: 10, y: 5, z: 10 }, normal: { x: 0, y: 1, z: 0 }, weight: 1 },
    ];
    const fit = fitPlane(samples);
    expect(fit?.surface.kind).toBe("plane");
    expect(fit?.maxDeviation).toBeLessThan(1e-9);
    if (fit?.surface.kind === "plane") {
      expect(fit.surface.normal.y).toBeCloseTo(1, 9);
      expect(fit.surface.distance).toBeCloseTo(5, 9);
    }
  });

  it("recovers a cylinder's axis, radius and position", () => {
    const fit = fitCylinder(samplesOnCylinder(7.5, 30, 32));
    expect(fit?.surface.kind).toBe("cylinder");
    expect(fit?.maxDeviation).toBeLessThan(1e-6);
    if (fit?.surface.kind === "cylinder") {
      expect(fit.surface.radius).toBeCloseTo(7.5, 6);
      expect(Math.abs(fit.surface.axis.y)).toBeCloseTo(1, 6);
    }
  });

  it("recovers a cylinder on an arbitrary axis", () => {
    const fit = fitCylinder(samplesOnCylinder(3.25, 12, 32, "x"));
    if (fit?.surface.kind === "cylinder") {
      expect(fit.surface.radius).toBeCloseTo(3.25, 6);
      expect(Math.abs(fit.surface.axis.x)).toBeCloseTo(1, 6);
    }
  });

  it("recovers a sphere's centre and radius", () => {
    const samples: FitSample[] = [];
    for (let lon = 0; lon < 16; lon += 1) {
      for (let lat = 1; lat < 8; lat += 1) {
        const theta = (lat / 8) * Math.PI;
        const phi = (lon / 16) * Math.PI * 2;
        const direction = {
          x: Math.sin(theta) * Math.cos(phi),
          y: Math.cos(theta),
          z: Math.sin(theta) * Math.sin(phi),
        };
        samples.push({
          point: { x: 2 + direction.x * 6, y: -1 + direction.y * 6, z: 4 + direction.z * 6 },
          normal: direction,
          weight: 1,
        });
      }
    }
    const fit = fitSphere(samples);
    expect(fit?.maxDeviation).toBeLessThan(1e-6);
    if (fit?.surface.kind === "sphere") {
      expect(fit.surface.radius).toBeCloseTo(6, 6);
      expect(fit.surface.center.x).toBeCloseTo(2, 6);
      expect(fit.surface.center.z).toBeCloseTo(4, 6);
    }
  });

  it("recovers a cone's half angle and apex", () => {
    const halfAngle = Math.PI / 6;
    const samples: FitSample[] = [];
    for (let index = 0; index < 32; index += 1) {
      const phi = (index / 32) * Math.PI * 2;
      for (const along of [4, 8, 12]) {
        const radius = along * Math.tan(halfAngle);
        // Apex at the origin, axis along +Y.
        const outward = { x: Math.cos(phi), y: 0, z: Math.sin(phi) };
        samples.push({
          point: { x: outward.x * radius, y: along, z: outward.z * radius },
          normal: {
            x: outward.x * Math.cos(halfAngle),
            y: -Math.sin(halfAngle),
            z: outward.z * Math.cos(halfAngle),
          },
          weight: 1,
        });
      }
    }
    const fit = fitCone(samples);
    expect(fit?.surface.kind).toBe("cone");
    expect(fit?.maxDeviation).toBeLessThan(1e-5);
    if (fit?.surface.kind === "cone") {
      expect(Math.abs(fit.surface.halfAngle)).toBeCloseTo(halfAngle, 4);
      expect(Math.hypot(fit.surface.apex.x, fit.surface.apex.y, fit.surface.apex.z)).toBeLessThan(1e-3);
    }
  });
});

describe("segmentMesh", () => {
  it("recognises a box as exactly six planes", () => {
    const topology = buildMeshTopology(boxMesh(40, 20, 30));
    const { segments, unassignedTriangles } = segmentMesh(topology, { tolerance: 0.05 });

    expect(unassignedTriangles).toHaveLength(0);
    expect(segments).toHaveLength(6);
    expect(segments.every((segment) => segment.fit.surface.kind === "plane")).toBe(true);
    expect(segments.every((segment) => segment.triangles.length === 2)).toBe(true);
  });

  it("recognises a tessellated cylinder as one cylinder and two caps", () => {
    const topology = buildMeshTopology(cylinderMesh(10, 20, 48));
    const { segments } = segmentMesh(topology, { tolerance: 0.05, angleTolerance: 15 });

    const kinds = segments.map((segment) => segment.fit.surface.kind).sort();
    expect(kinds).toEqual(["cylinder", "plane", "plane"]);

    const cylinder = segments.find((segment) => segment.fit.surface.kind === "cylinder");
    expect(cylinder?.triangles).toHaveLength(48 * 2);
    if (cylinder?.fit.surface.kind === "cylinder") {
      expect(cylinder.fit.surface.radius).toBeCloseTo(10, 4);
      expect(Math.abs(cylinder.fit.surface.axis.y)).toBeCloseTo(1, 6);
    }
  });

  it("recognises a tessellated sphere as a single sphere", () => {
    const topology = buildMeshTopology(sphereMesh(12, 32, 20));
    const { segments } = segmentMesh(topology, { tolerance: 0.05, angleTolerance: 15 });

    const sphere = segments.find((segment) => segment.fit.surface.kind === "sphere");
    expect(sphere).toBeDefined();
    if (sphere?.fit.surface.kind === "sphere") {
      expect(sphere.fit.surface.radius).toBeCloseTo(12, 2);
    }
    // The sphere patch must dominate; a fragmented result would mean the
    // surface-based growing had collapsed back to per-facet planes.
    expect((sphere?.triangles.length ?? 0) / topology.triangleCount).toBeGreaterThan(0.9);
  });

  it("recognises a cone's flank and base", () => {
    const topology = buildMeshTopology(coneMesh(8, 16, 48));
    const { segments } = segmentMesh(topology, { tolerance: 0.05, angleTolerance: 15 });

    const cone = segments.find((segment) => segment.fit.surface.kind === "cone");
    const base = segments.find((segment) => segment.fit.surface.kind === "plane");
    expect(cone).toBeDefined();
    expect(base).toBeDefined();
    if (cone?.fit.surface.kind === "cone") {
      expect(Math.abs(cone.fit.surface.halfAngle)).toBeCloseTo(Math.atan(8 / 16), 2);
    }
  });
});

describe("regularizeSegments", () => {
  function planeSegment(id: number, normal: { x: number; y: number; z: number }, distance: number): MeshSegment {
    return {
      id,
      triangles: [id],
      area: 100,
      fit: { surface: { kind: "plane", normal, distance }, maxDeviation: 0, rmsDeviation: 0 },
    };
  }

  it("snaps a nearly axis-aligned normal onto the world axis", () => {
    const tilt = (0.4 * Math.PI) / 180;
    const { segments, report } = regularizeSegments(
      [planeSegment(0, { x: Math.sin(tilt), y: Math.cos(tilt), z: 0 }, 5)],
      { angleTolerance: 1.5, snapToWorldAxes: true, dimensionGrid: 0 },
    );

    const surface = segments[0].fit.surface;
    expect(surface.kind).toBe("plane");
    if (surface.kind === "plane") {
      expect(surface.normal.x).toBeCloseTo(0, 12);
      expect(surface.normal.y).toBeCloseTo(1, 12);
    }
    expect(report.axesSnappedToWorld).toBe(1);
  });

  it("keeps opposite faces in their own hemispheres while sharing a direction", () => {
    const { segments } = regularizeSegments(
      [
        planeSegment(0, { x: 0, y: 0.9999, z: 0.014 }, 10),
        planeSegment(1, { x: 0, y: -0.9999, z: -0.014 }, -10),
      ],
      { angleTolerance: 2, snapToWorldAxes: true, dimensionGrid: 0 },
    );

    const first = segments[0].fit.surface;
    const second = segments[1].fit.surface;
    if (first.kind === "plane" && second.kind === "plane") {
      expect(first.normal.y).toBeCloseTo(1, 9);
      expect(second.normal.y).toBeCloseTo(-1, 9);
    }
  });

  it("rounds a measured radius onto the dimension grid", () => {
    const { segments, report } = regularizeSegments(
      [
        {
          id: 0,
          triangles: [0],
          area: 50,
          fit: {
            surface: { kind: "cylinder", axis: { x: 0, y: 1, z: 0 }, point: { x: 0, y: 0, z: 0 }, radius: 4.9987 },
            maxDeviation: 0.002,
            rmsDeviation: 0.001,
          },
        },
      ],
      { dimensionGrid: 0.1 },
    );

    const surface = segments[0].fit.surface;
    expect(surface.kind).toBe("cylinder");
    if (surface.kind === "cylinder") expect(surface.radius).toBeCloseTo(5, 9);
    expect(report.dimensionsRounded).toBe(1);
  });

  it("pulls nearly coaxial cylinders onto one axis", () => {
    const makeCylinder = (id: number, x: number): MeshSegment => ({
      id,
      triangles: [id],
      area: 50,
      fit: {
        surface: { kind: "cylinder", axis: { x: 0, y: 1, z: 0 }, point: { x, y: 0, z: 0 }, radius: 5 },
        maxDeviation: 0,
        rmsDeviation: 0,
      },
    });

    const { segments, report } = regularizeSegments([makeCylinder(0, 0), makeCylinder(1, 0.02)], {
      dimensionGrid: 0.1,
      enforceCoaxial: true,
    });

    expect(report.coaxialGroups).toBe(1);
    const first = segments[0].fit.surface;
    const second = segments[1].fit.surface;
    if (first.kind === "cylinder" && second.kind === "cylinder") {
      expect(second.point.x).toBeCloseTo(first.point.x, 9);
    }
  });
});

describe("analyzeMeshForConversion", () => {
  it("reports full coverage and an accurate tally for a box", () => {
    const analysis = analyzeMeshForConversion(boxMesh(40, 20, 30), { tolerance: 0.05 });

    expect(analysis.manifold).toBe(true);
    expect(analysis.tally).toEqual({ plane: 6, cylinder: 0, cone: 0, sphere: 0 });
    expect(analysis.coverage).toBeCloseTo(1, 9);
    expect(analysis.unassignedTriangles).toHaveLength(0);
    expect(analysis.regularization.axesSnappedToWorld).toBe(3);
  });

  it("recognises a cylinder and summarises it in one line", () => {
    const analysis = analyzeMeshForConversion(cylinderMesh(10, 20, 48), { tolerance: 0.05, angleTolerance: 15 });

    expect(analysis.tally.cylinder).toBe(1);
    expect(analysis.tally.plane).toBe(2);
    expect(analysis.coverage).toBeCloseTo(1, 6);
    expect(describeConversion(analysis)).toMatch(/2 planes, 1 cylinder — 100% of the surface\./);
  });

  it("says so plainly when nothing is recognised", () => {
    const analysis = analyzeMeshForConversion([], { tolerance: 0.05 });
    expect(describeConversion(analysis)).toMatch(/No analytic surfaces/);
  });
});
