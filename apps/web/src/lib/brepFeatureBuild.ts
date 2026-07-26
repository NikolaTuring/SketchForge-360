// Building a body from a sketch, and reading a solid's planar faces.
//
// Separate from the worker that calls it so the geometry can be driven directly
// by the end-to-end suite against the real OpenCascade kernel. A worker module
// can only be exercised through messages, and a message round trip is a poor
// place to find out that a normal points the wrong way.

import type { OcctKernel, ShapeHandle } from "occt-wasm";

import {
  applyFeatureOperation,
  extrudeRegions,
  revolveRegions,
  type SketchFeatureKernel,
} from "@/lib/brepSketchFeatures";
import {
  FEATURE_WIREFRAME_DEFLECTION,
  type BrepFeatureBody,
  type MeshConversionReport,
  type PlanarFaceInfo,
  type SketchFeatureBuild,
} from "@/lib/brepFeatureTypes";
import { analyzeMeshForConversion, describeConversion, type MeshConversionSettings } from "@/lib/meshToBrep";
import { sketchFrame } from "@/lib/sketchEntities";
import { findSketchRegions } from "@/lib/sketchProfiles";
import { solveSketch } from "@/lib/sketchSolver";

/**
 * Releases handles in reverse order, and never lets a release failure mask the
 * error that is already on its way out.
 */
export function releaseAll(kernel: OcctKernel, handles: ShapeHandle[]) {
  for (let index = handles.length - 1; index >= 0; index -= 1) {
    try {
      kernel.release(handles[index]);
    } catch {
      // A handle can already be gone if the operation that produced it failed.
    }
  }
}

export function boundsOf(positions: Float32Array) {
  if (positions.length === 0) {
    return { width: 0, depth: 0, height: 0, center: { x: 0, y: 0, z: 0 } };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    // The editor's width/depth/height are the world X/Z/Y spans respectively,
    // matching how a `WorkplaneShape` is measured everywhere else.
    width: maxX - minX,
    depth: maxZ - minZ,
    height: maxY - minY,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
  };
}

/**
 * Display tessellation quality.
 *
 * Finer than the kernel's defaults (0.1 mm / 0.5 rad) in the angular term,
 * which is the one that matters for a small hole: at half a radian a 5 mm bore
 * becomes a twelve-sided prism, which both looks wrong and defeats surface
 * recognition — every facet reads as its own plane instead of one cylinder.
 */
const FEATURE_TESSELLATION = { linearDeflection: 0.06, angularDeflection: 0.16 };

/** Splits the flat wireframe sample buffer back into one polyline per edge. */
export function displayEdgesOf(kernel: OcctKernel, shape: ShapeHandle) {
  const wireframe = kernel.wireframe(shape, FEATURE_WIREFRAME_DEFLECTION);
  const edges: { points: number[] }[] = [];
  for (let group = 0; group + 2 < wireframe.edgeGroups.length; group += 3) {
    const start = wireframe.edgeGroups[group];
    const count = wireframe.edgeGroups[group + 1];
    if (count < 2) continue;
    edges.push({ points: Array.from(wireframe.points.subarray(start * 3, (start + count) * 3)) });
  }
  return edges;
}

export function bodyFromShape(kernel: OcctKernel, shape: ShapeHandle): BrepFeatureBody {
  const mesh = kernel.tessellate(shape, FEATURE_TESSELLATION);
  // The kernel reuses its output buffers between calls, so every array has to
  // be copied before it can be transferred out of the worker.
  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  const indices = new Uint32Array(mesh.indices);
  const bounds = boundsOf(positions);

  /*
   * The STEP text is emitted from a copy moved into the body's own local frame
   * — centred in x and z, sitting on y = 0 — because that is the frame the
   * mesh is stored in and the frame the exporter reads it back in. Emitting it
   * where the kernel happened to build it produces a STEP file whose contents
   * are correct and whose position is wrong by the body's placement, which is
   * invisible until someone opens the export in another program.
   */
  const local = kernel.translate(shape, -bounds.center.x, -(bounds.center.y - bounds.height / 2), -bounds.center.z);
  let stepText: string;
  try {
    stepText = kernel.exportStep(local);
  } finally {
    kernel.release(local);
  }

  return {
    positions,
    normals,
    indices,
    triangleCount: mesh.triangleCount,
    brep: kernel.toBREP(shape),
    stepText,
    displayEdges: displayEdgesOf(kernel, shape),
    volume: kernel.getVolume(shape),
    bounds,
  };
}

export function buildSketchFeature(kernel: OcctKernel, build: SketchFeatureBuild): BrepFeatureBody {
  const solved = solveSketch(build.sketch);
  if (solved.status === "invalid") {
    // Report the first dimension that could not be evaluated if there is one:
    // "25 + " is a far more useful message than "the sketch is invalid".
    const [firstDimensionError] = [...solved.dimensionErrors.values()];
    throw new Error(firstDimensionError ?? "The sketch could not be solved with these constraints");
  }

  const frame = sketchFrame(build.sketch.plane);
  const profile = findSketchRegions(solved.entities);
  const regions = build.regionKeys
    ? profile.regions.filter((region) => build.regionKeys?.includes(region.id))
    : profile.regions;

  if (regions.length === 0) {
    throw new Error(
      profile.openEntityIds.length > 0
        ? "The sketch has no closed profile — some geometry does not join up"
        : "Select at least one closed profile",
    );
  }

  const owned: ShapeHandle[] = [];
  try {
    const feature = build.revolve
      ? revolveRegions(kernel as SketchFeatureKernel, frame, regions, solved.entities, build.revolve)
      : extrudeRegions(kernel as SketchFeatureKernel, frame, regions, solved.entities, build.extrude ?? { distance: 10 });
    owned.push(feature.shape);

    const targets: ShapeHandle[] = [];
    if (build.operation !== "new" && build.targetBrep) {
      const target = kernel.fromBREP(build.targetBrep);
      owned.push(target);
      targets.push(target);
    }

    const combined = applyFeatureOperation(kernel as SketchFeatureKernel, build.operation, feature.shape, targets);
    // `applyFeatureOperation` returns the tool unchanged for a "new" feature, so
    // only track the result when it really is a new handle.
    if (combined !== feature.shape) owned.push(combined);

    if (!kernel.isValid(combined)) {
      throw new Error("The feature produced invalid geometry — check the profile and the distance");
    }
    return bodyFromShape(kernel, combined);
  } finally {
    releaseAll(kernel, owned);
  }
}

/**
 * Lists the planar faces of a body, so a sketch can be started on one.
 *
 * The normal is sampled at the middle of the face's parameter range and is
 * already outward: this kernel's `surfaceNormal` accounts for the face's
 * orientation, so flipping it again on a reversed face turns a correct normal
 * inward — and a sketch plane on an inward normal extrudes into the body it was
 * drawn on. Verified against a box in the end-to-end suite, which asserts the
 * six axis directions appear exactly once each.
 */
export function listPlanarFaces(kernel: OcctKernel, brep: string): PlanarFaceInfo[] {
  const owned: ShapeHandle[] = [];
  try {
    const shape = kernel.fromBREP(brep);
    owned.push(shape);
    const faces = kernel.getSubShapes(shape, "face");
    owned.push(...faces);

    const planar: PlanarFaceInfo[] = [];
    faces.forEach((face, index) => {
      if (kernel.surfaceType(face) !== "plane") return;
      const uv = kernel.uvBounds(face);
      const u = (uv.uMin + uv.uMax) / 2;
      const v = (uv.vMin + uv.vMax) / 2;
      const origin = kernel.pointOnSurface(face, u, v);
      const raw = kernel.surfaceNormal(face, u, v);
      const length = Math.hypot(raw.x, raw.y, raw.z) || 1;
      planar.push({
        index,
        origin,
        normal: { x: raw.x / length, y: raw.y / length, z: raw.z / length },
        area: kernel.getSurfaceArea(face),
      });
    });
    // Largest first: the face someone means is almost always a big flat one,
    // and a stable order keeps a remembered choice pointing at the same face.
    return planar.sort((a, b) => b.area - a.area);
  } finally {
    releaseAll(kernel, owned);
  }
}

/** Edges with only one triangle: the mesh is an open shell, not a closed solid. */
function countBoundaryEdges(topology: { adjacency: Int32Array }) {
  let open = 0;
  for (let slot = 0; slot < topology.adjacency.length; slot += 1) {
    if (topology.adjacency[slot] < 0) open += 1;
  }
  return open;
}

/**
 * Recognises the analytic surfaces in a mesh and summarises what was found.
 *
 * `indices` is optional because the two callers differ: an imported STL arrives
 * as a triangle soup, the kernel's own tessellation arrives indexed.
 */
export function convertMesh(
  positions: Float32Array,
  settings: MeshConversionSettings,
  indices?: Uint32Array,
): MeshConversionReport {
  const analysis = analyzeMeshForConversion(positions, settings, indices);
  return {
    tally: analysis.tally,
    coverage: analysis.coverage,
    manifold: analysis.manifold,
    triangleCount: analysis.topology.triangleCount,
    unassignedTriangles: analysis.unassignedTriangles.length,
    boundaryEdges: countBoundaryEdges(analysis.topology),
    nonManifoldEdges: analysis.topology.nonManifoldEdgeCount,
    directionClusters: analysis.regularization.directionClusters,
    axesSnappedToWorld: analysis.regularization.axesSnappedToWorld,
    dimensionsRounded: analysis.regularization.dimensionsRounded,
    coaxialGroups: analysis.regularization.coaxialGroups,
    summary: describeConversion(analysis),
  };
}
