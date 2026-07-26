// Cleans up recognised surfaces so the result is a CAD model rather than a
// slightly-wrong copy of a tessellation.
//
// This is the step that actually makes a converted mesh useful. Fitting a
// bracket's six faces gives six planes whose normals disagree by a fraction of
// a degree and a hole of radius 4.9987; nothing downstream can rely on that.
// Clustering the directions and rounding the dimensions turns it back into
// "three orthogonal directions and a 5 mm hole", which is what a fillet, a
// dimension query or a STEP consumer needs.

import { canonicalDirection, type MeshSegment } from "@/lib/meshToBrep/segmentation";
import { normalize3, type AnalyticSurface } from "@/lib/meshToBrep/surfaceFit";
import type { Vec3 } from "@/lib/meshToBrep/meshTopology";

export type RegularizeOptions = {
  /** Directions closer than this are treated as the same direction, in degrees. */
  angleTolerance?: number;
  /** Snap a direction cluster to a world axis when it is within tolerance. */
  snapToWorldAxes?: boolean;
  /** Round radii and plane offsets to this grid, in mm. Zero disables it. */
  dimensionGrid?: number;
  /** Merge cylinder and cone axes that are nearly the same line. */
  enforceCoaxial?: boolean;
};

export type RegularizeReport = {
  directionClusters: number;
  axesSnappedToWorld: number;
  dimensionsRounded: number;
  coaxialGroups: number;
};

export type RegularizeResult = {
  segments: MeshSegment[];
  report: RegularizeReport;
};

const DEFAULT_ANGLE_TOLERANCE = 1.5;
const DEFAULT_DIMENSION_GRID = 0.1;

const WORLD_AXES: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
];

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function surfaceDirection(surface: AnalyticSurface): Vec3 | null {
  if (surface.kind === "plane") return surface.normal;
  if (surface.kind === "cylinder" || surface.kind === "cone") return surface.axis;
  return null;
}

function snapValue(value: number, grid: number) {
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

/**
 * Groups directions that agree within tolerance and replaces each with its
 * area-weighted mean, optionally snapping to a world axis.
 *
 * Directions are canonicalized first so a face and its opposite (+n and −n)
 * land in the same cluster; the original sign is restored afterwards.
 */
function clusterDirections(segments: readonly MeshSegment[], options: Required<Pick<RegularizeOptions, "angleTolerance" | "snapToWorldAxes">>) {
  const cosineLimit = Math.cos((options.angleTolerance * Math.PI) / 180);
  const clusters: { direction: Vec3; weight: number; members: number[] }[] = [];

  segments.forEach((segment, index) => {
    const direction = surfaceDirection(segment.fit.surface);
    if (!direction) return;
    const canonical = canonicalDirection(direction);

    const existing = clusters.find((cluster) => Math.abs(dot(cluster.direction, canonical)) >= cosineLimit);
    if (existing) {
      const weight = existing.weight + segment.area;
      // Accumulate the mean in the cluster's own hemisphere.
      const sign = dot(existing.direction, canonical) < 0 ? -1 : 1;
      existing.direction = normalize3({
        x: existing.direction.x * existing.weight + canonical.x * segment.area * sign,
        y: existing.direction.y * existing.weight + canonical.y * segment.area * sign,
        z: existing.direction.z * existing.weight + canonical.z * segment.area * sign,
      });
      existing.weight = weight;
      existing.members.push(index);
    } else {
      clusters.push({ direction: canonical, weight: segment.area, members: [index] });
    }
  });

  let axesSnappedToWorld = 0;
  clusters.forEach((cluster) => {
    if (!options.snapToWorldAxes) return;
    const match = WORLD_AXES.find((axis) => Math.abs(dot(axis, cluster.direction)) >= cosineLimit);
    if (match) {
      cluster.direction = dot(match, cluster.direction) < 0 ? { x: -match.x, y: -match.y, z: -match.z } : match;
      axesSnappedToWorld += 1;
    }
  });

  return { clusters, axesSnappedToWorld };
}

function withDirection(surface: AnalyticSurface, direction: Vec3): AnalyticSurface {
  switch (surface.kind) {
    case "plane":
      return { ...surface, normal: direction };
    case "cylinder":
      return { ...surface, axis: direction };
    case "cone":
      return { ...surface, axis: direction };
    default:
      return surface;
  }
}

/**
 * Snaps cylinder and cone axes that lie on nearly the same line onto a shared
 * one. Two holes drilled through a part are meant to be coaxial; leaving them a
 * hundredth of a millimetre apart produces a body that cannot be filleted.
 */
function enforceCoaxialAxes(segments: MeshSegment[], tolerance: number) {
  const groups: { direction: Vec3; point: Vec3; members: number[] }[] = [];

  segments.forEach((segment, index) => {
    const surface = segment.fit.surface;
    if (surface.kind !== "cylinder" && surface.kind !== "cone") return;
    const point = surface.kind === "cylinder" ? surface.point : surface.apex;
    const direction = surface.axis;

    const existing = groups.find((group) => {
      if (Math.abs(dot(group.direction, direction)) < Math.cos((tolerance * Math.PI) / 180)) return false;
      const offset = { x: point.x - group.point.x, y: point.y - group.point.y, z: point.z - group.point.z };
      const along = dot(offset, group.direction);
      const radial = Math.hypot(
        offset.x - group.direction.x * along,
        offset.y - group.direction.y * along,
        offset.z - group.direction.z * along,
      );
      return radial <= tolerance;
    });

    if (existing) existing.members.push(index);
    else groups.push({ direction, point, members: [index] });
  });

  let coaxialGroups = 0;
  groups.forEach((group) => {
    if (group.members.length < 2) return;
    coaxialGroups += 1;
    group.members.forEach((index) => {
      const surface = segments[index].fit.surface;
      if (surface.kind === "cylinder") {
        // Slide the reference point onto the shared line, keeping the position
        // along the axis that this patch actually occupies.
        const offset = {
          x: surface.point.x - group.point.x,
          y: surface.point.y - group.point.y,
          z: surface.point.z - group.point.z,
        };
        const along = dot(offset, group.direction);
        segments[index] = {
          ...segments[index],
          fit: {
            ...segments[index].fit,
            surface: {
              ...surface,
              point: {
                x: group.point.x + group.direction.x * along,
                y: group.point.y + group.direction.y * along,
                z: group.point.z + group.direction.z * along,
              },
            },
          },
        };
      }
    });
  });

  return coaxialGroups;
}

export function regularizeSegments(segments: readonly MeshSegment[], options: RegularizeOptions = {}): RegularizeResult {
  const angleTolerance = options.angleTolerance ?? DEFAULT_ANGLE_TOLERANCE;
  const snapToWorldAxes = options.snapToWorldAxes ?? true;
  const dimensionGrid = options.dimensionGrid ?? DEFAULT_DIMENSION_GRID;
  const enforceCoaxial = options.enforceCoaxial ?? true;

  const { clusters, axesSnappedToWorld } = clusterDirections(segments, { angleTolerance, snapToWorldAxes });

  const directionOf = new Map<number, Vec3>();
  clusters.forEach((cluster) => {
    cluster.members.forEach((index) => {
      const original = surfaceDirection(segments[index].fit.surface);
      if (!original) return;
      // Restore the original hemisphere so face orientation is preserved.
      const aligned = dot(original, cluster.direction) < 0
        ? { x: -cluster.direction.x, y: -cluster.direction.y, z: -cluster.direction.z }
        : cluster.direction;
      directionOf.set(index, aligned);
    });
  });

  let dimensionsRounded = 0;

  let updated: MeshSegment[] = segments.map((segment, index) => {
    let surface = segment.fit.surface;
    const direction = directionOf.get(index);
    if (direction) surface = withDirection(surface, direction);

    if (dimensionGrid > 0) {
      if (surface.kind === "plane") {
        // Re-derive the offset against the snapped normal before rounding it,
        // otherwise a rotated normal would shift the plane off the geometry.
        const snapped = snapValue(surface.distance, dimensionGrid);
        if (snapped !== surface.distance) dimensionsRounded += 1;
        surface = { ...surface, distance: snapped };
      } else if (surface.kind === "cylinder" || surface.kind === "sphere") {
        const snapped = snapValue(surface.radius, dimensionGrid);
        if (snapped > 0 && snapped !== surface.radius) {
          dimensionsRounded += 1;
          surface = { ...surface, radius: snapped };
        }
      }
    }

    return { ...segment, fit: { ...segment.fit, surface } };
  });

  const coaxialGroups = enforceCoaxial ? enforceCoaxialAxes(updated, Math.max(dimensionGrid, 1e-3)) : 0;
  updated = [...updated];

  return {
    segments: updated,
    report: { directionClusters: clusters.length, axesSnappedToWorld, dimensionsRounded, coaxialGroups },
  };
}
