// Mesh → analytic surface recognition.
//
// An imported STL is a triangle soup: no faces, no edges, no dimensions. This
// pipeline recovers the planes, cylinders, cones and spheres the part was
// originally made of, and regularizes them so the answer is a clean CAD model
// rather than a slightly-wrong copy of the tessellation.
//
// It reports honestly. `coverage` says how much of the surface area was actually
// recognised, and `unassignedTriangles` says exactly what was not, so the caller
// can tell the user "48 planes, 12 cylinders, 3 regions kept as facets" instead
// of silently presenting a partial reconstruction as a finished conversion.

import { buildMeshTopology, isManifold, type MeshTopology } from "@/lib/meshToBrep/meshTopology";
import { segmentMesh, type MeshSegment, type SegmentationOptions } from "@/lib/meshToBrep/segmentation";
import { regularizeSegments, type RegularizeOptions, type RegularizeReport } from "@/lib/meshToBrep/regularize";
import type { SurfaceKind } from "@/lib/meshToBrep/surfaceFit";

export { buildMeshTopology, isManifold, triangleCentroid, triangleNormal, triangleVertex } from "@/lib/meshToBrep/meshTopology";
export type { MeshTopology, Vec3 } from "@/lib/meshToBrep/meshTopology";
export { segmentMesh, canonicalDirection } from "@/lib/meshToBrep/segmentation";
export type { MeshSegment, SegmentationOptions, SegmentationResult } from "@/lib/meshToBrep/segmentation";
export { regularizeSegments } from "@/lib/meshToBrep/regularize";
export type { RegularizeOptions, RegularizeReport, RegularizeResult } from "@/lib/meshToBrep/regularize";
export {
  distanceToSurface,
  fitBestSurface,
  fitCone,
  fitCylinder,
  fitPlane,
  fitSphere,
  surfaceNormalAt,
  symmetricEigen3,
} from "@/lib/meshToBrep/surfaceFit";
export type {
  AnalyticSurface,
  ConeSurface,
  CylinderSurface,
  FitSample,
  PlaneSurface,
  SphereSurface,
  SurfaceFit,
  SurfaceKind,
} from "@/lib/meshToBrep/surfaceFit";

export type MeshConversionSettings = SegmentationOptions & RegularizeOptions;

export type SurfaceTally = Record<SurfaceKind, number>;

export type MeshConversionAnalysis = {
  topology: MeshTopology;
  segments: MeshSegment[];
  unassignedTriangles: number[];
  tally: SurfaceTally;
  /** Fraction of total surface area accounted for by recognised surfaces. */
  coverage: number;
  /** A closed two-manifold mesh is a precondition for a solid rebuild. */
  manifold: boolean;
  regularization: RegularizeReport;
};

function emptyTally(): SurfaceTally {
  return { plane: 0, cylinder: 0, cone: 0, sphere: 0 };
}

export function analyzeMeshForConversion(
  positions: readonly number[],
  settings: MeshConversionSettings = {},
): MeshConversionAnalysis {
  const topology = buildMeshTopology(positions);
  const { segments, unassignedTriangles } = segmentMesh(topology, settings);
  const { segments: regularized, report } = regularizeSegments(segments, settings);

  const tally = emptyTally();
  regularized.forEach((segment) => {
    tally[segment.fit.surface.kind] += 1;
  });

  let totalArea = 0;
  for (let triangle = 0; triangle < topology.triangleCount; triangle += 1) totalArea += topology.areas[triangle];
  const recognisedArea = regularized.reduce((total, segment) => total + segment.area, 0);

  return {
    topology,
    segments: regularized,
    unassignedTriangles,
    tally,
    coverage: totalArea > 0 ? recognisedArea / totalArea : 0,
    manifold: isManifold(topology),
    regularization: report,
  };
}

/** One-line summary for the conversion panel and the notice bar. */
export function describeConversion(analysis: MeshConversionAnalysis): string {
  const parts = (Object.entries(analysis.tally) as [SurfaceKind, number][])
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`);

  if (parts.length === 0) return "No analytic surfaces were recognised in this mesh.";

  const percentage = Math.round(analysis.coverage * 100);
  const leftover = analysis.unassignedTriangles.length;
  const tail = leftover > 0 ? `; ${leftover} triangle${leftover === 1 ? "" : "s"} kept as facets` : "";
  return `${parts.join(", ")} — ${percentage}% of the surface${tail}.`;
}
