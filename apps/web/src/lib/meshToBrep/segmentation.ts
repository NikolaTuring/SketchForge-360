// Splits a mesh into patches that each correspond to one analytic surface.
//
// Growing purely on the angle between neighbouring triangle normals does not
// work: on a cylinder every neighbour differs by the tessellation angle, so the
// cylinder would come apart into strips. Instead a candidate surface is fitted
// from the seed's immediate neighbourhood and triangles are then admitted by
// how well they match *that surface* — which is scale-independent and lets a
// whole cylinder grow as one patch.

import {
  fitBestSurface,
  distanceToSurface,
  surfaceNormalAt,
  normalize3,
  type FitSample,
  type SurfaceFit,
} from "@/lib/meshToBrep/surfaceFit";
import {
  triangleCentroid,
  triangleNormal,
  triangleVertex,
  type MeshTopology,
  type Vec3,
} from "@/lib/meshToBrep/meshTopology";

export type MeshSegment = {
  id: number;
  triangles: number[];
  fit: SurfaceFit;
  /** Total triangle area of the patch, in mm². */
  area: number;
};

export type SegmentationOptions = {
  /** Maximum deviation from the fitted surface, in millimetres. */
  tolerance?: number;
  /** Maximum angle between a triangle normal and the surface normal, degrees. */
  angleTolerance?: number;
  /** Patches smaller than this are left unassigned rather than trusted. */
  minTriangles?: number;
};

export type SegmentationResult = {
  segments: MeshSegment[];
  /** Triangles no analytic surface could account for within tolerance. */
  unassignedTriangles: number[];
};

const DEFAULT_TOLERANCE = 0.05;
const DEFAULT_ANGLE_TOLERANCE = 12;
const DEFAULT_MIN_TRIANGLES = 2;

function sampleFor(topology: MeshTopology, triangle: number): FitSample[] {
  const normal = triangleNormal(topology, triangle);
  const weight = topology.areas[triangle] / 3;
  return [0, 1, 2].map((corner) => ({ point: triangleVertex(topology, triangle, corner), normal, weight }));
}

function samplesFor(topology: MeshTopology, triangles: readonly number[]): FitSample[] {
  return triangles.flatMap((triangle) => sampleFor(topology, triangle));
}

function neighboursOf(topology: MeshTopology, triangle: number): number[] {
  const found: number[] = [];
  for (let edge = 0; edge < 3; edge += 1) {
    const neighbour = topology.adjacency[triangle * 3 + edge];
    if (neighbour >= 0) found.push(neighbour);
  }
  return found;
}

/**
 * How far a neighbour's normal may stray from the seed's before it is treated as
 * belonging to a different surface.
 *
 * Without this the seed neighbourhood walks straight over the rim of a cylinder
 * onto its end cap, and the cap normals (perpendicular to the side ones) destroy
 * the axis estimate — the cylinder's defining property is that all its normals
 * are perpendicular to one direction, which cap normals violate completely.
 * A generous limit still admits several facets of any reasonable tessellation
 * while excluding a genuine surface boundary.
 */
const SEED_NORMAL_LIMIT_DEGREES = 45;

/** Seed neighbourhood: the triangle plus its one- and two-ring neighbours. */
function seedNeighbourhood(topology: MeshTopology, seed: number, assigned: Int32Array): number[] {
  const seedNormal = triangleNormal(topology, seed);
  const cosineLimit = Math.cos((SEED_NORMAL_LIMIT_DEGREES * Math.PI) / 180);

  const collected = new Set<number>([seed]);
  let frontier = [seed];
  for (let ring = 0; ring < 2 && collected.size < 24; ring += 1) {
    const next: number[] = [];
    frontier.forEach((triangle) => {
      neighboursOf(topology, triangle).forEach((neighbour) => {
        if (assigned[neighbour] >= 0 || collected.has(neighbour)) return;
        const normal = triangleNormal(topology, neighbour);
        const alignment = Math.abs(seedNormal.x * normal.x + seedNormal.y * normal.y + seedNormal.z * normal.z);
        if (alignment < cosineLimit) return;
        collected.add(neighbour);
        next.push(neighbour);
      });
    });
    frontier = next;
  }
  return [...collected];
}

function trianglesMatchSurface(
  topology: MeshTopology,
  triangle: number,
  fit: SurfaceFit,
  tolerance: number,
  cosineLimit: number,
): boolean {
  for (let corner = 0; corner < 3; corner += 1) {
    const vertex = triangleVertex(topology, triangle, corner);
    if (Math.abs(distanceToSurface(fit.surface, vertex)) > tolerance) return false;
  }

  const centroid = triangleCentroid(topology, triangle);
  const expected = surfaceNormalAt(fit.surface, centroid);
  // No defined normal at a singular point (a cone apex, a cylinder axis), so
  // the position test above is all there is to go on.
  if (!expected) return true;
  const actual = triangleNormal(topology, triangle);
  // Compare unsigned: a fitted plane's orientation is arbitrary until the patch
  // is complete, and an inward-facing STL triangle should still be recognised.
  const alignment = Math.abs(expected.x * actual.x + expected.y * actual.y + expected.z * actual.z);
  return alignment >= cosineLimit;
}

/**
 * Flood-fills from a seed across smooth transitions, ignoring surfaces entirely.
 *
 * This is the bootstrap. Fitting a cone needs a wide span of its Gauss circle —
 * over a couple of facets that arc is nearly a straight line and a cone, a
 * cylinder and a plane all explain it equally well. Walking across every
 * neighbour whose normal turns by less than the tessellation step sweeps a whole
 * flank in one go and stops dead at a real edge, which gives the fit the span it
 * needs. Tangent-continuous neighbours that genuinely belong to different
 * surfaces are separated again by the surface-based regrow that follows.
 */
function growByNormalContinuity(
  topology: MeshTopology,
  seed: number,
  assigned: Int32Array,
  cosineLimit: number,
): number[] {
  const members: number[] = [];
  const visited = new Set<number>([seed]);
  const queue: number[] = [seed];

  while (queue.length > 0) {
    const triangle = queue.pop() as number;
    if (assigned[triangle] >= 0) continue;
    members.push(triangle);

    const normal = triangleNormal(topology, triangle);
    neighboursOf(topology, triangle).forEach((neighbour) => {
      if (assigned[neighbour] >= 0 || visited.has(neighbour)) return;
      const other = triangleNormal(topology, neighbour);
      const alignment = Math.abs(normal.x * other.x + normal.y * other.y + normal.z * other.z);
      if (alignment < cosineLimit) return;
      visited.add(neighbour);
      queue.push(neighbour);
    });
  }

  return members;
}

/**
 * Flood-fills from a seed, admitting triangles that match `fit`.
 *
 * Nothing is written to `assigned` — triangles already claimed by an earlier
 * segment are skipped, but the patch is only committed once the caller is
 * satisfied with it, which is what lets the fit be revised between rounds.
 */
function growPatch(
  topology: MeshTopology,
  seed: number,
  fit: SurfaceFit,
  assigned: Int32Array,
  tolerance: number,
  cosineLimit: number,
): number[] {
  const members: number[] = [];
  const visited = new Set<number>([seed]);
  const queue: number[] = [seed];

  while (queue.length > 0) {
    const triangle = queue.pop() as number;
    if (assigned[triangle] >= 0) continue;
    if (triangle !== seed && !trianglesMatchSurface(topology, triangle, fit, tolerance, cosineLimit)) continue;

    members.push(triangle);
    neighboursOf(topology, triangle).forEach((neighbour) => {
      if (assigned[neighbour] >= 0 || visited.has(neighbour)) return;
      visited.add(neighbour);
      queue.push(neighbour);
    });
  }

  return members;
}

export function segmentMesh(topology: MeshTopology, options: SegmentationOptions = {}): SegmentationResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const angleTolerance = options.angleTolerance ?? DEFAULT_ANGLE_TOLERANCE;
  const minTriangles = options.minTriangles ?? DEFAULT_MIN_TRIANGLES;
  const cosineLimit = Math.cos((angleTolerance * Math.PI) / 180);

  const assigned = new Int32Array(topology.triangleCount).fill(-1);
  const segments: MeshSegment[] = [];

  // Largest triangles first: a big facet is the most reliable seed for the
  // surface it belongs to, and starting from noise-sized slivers produces
  // fragmented patches.
  const order = Array.from({ length: topology.triangleCount }, (_unused, index) => index).sort(
    (a, b) => topology.areas[b] - topology.areas[a],
  );

  order.forEach((seed) => {
    if (assigned[seed] >= 0) return;

    // Widest span first: the smooth-region flood fill, then a small
    // neighbourhood, then the seed alone. Each fallback describes less of the
    // surface, so the first one that yields a fit is the best informed.
    const smoothRegion = growByNormalContinuity(topology, seed, assigned, cosineLimit);
    let fit =
      fitBestSurface(samplesFor(topology, smoothRegion), tolerance, angleTolerance) ??
      fitBestSurface(samplesFor(topology, seedNeighbourhood(topology, seed, assigned)), tolerance, angleTolerance) ??
      fitBestSurface(sampleFor(topology, seed), tolerance, angleTolerance);
    if (!fit) return;

    // Grow, refit, grow again.
    //
    // A handful of facets cannot distinguish a cone from a cylinder — a short
    // arc of the Gauss circle is nearly a straight line, and both surfaces
    // explain it. Each round grows the patch under the current best guess and
    // refits against everything found, so the true surface emerges once enough
    // of it is present. Two or three rounds is ample; convergence is detected by
    // the patch no longer growing.
    let members = growPatch(topology, seed, fit, assigned, tolerance, cosineLimit);
    for (let round = 0; round < 3; round += 1) {
      const refit = fitBestSurface(samplesFor(topology, members), tolerance, angleTolerance);
      if (!refit) break;
      const grown = growPatch(topology, seed, refit, assigned, tolerance, cosineLimit);
      fit = refit;
      if (grown.length <= members.length) {
        members = grown.length > 0 ? grown : members;
        break;
      }
      members = grown;
    }

    if (members.length < minTriangles) return;

    const finalFit = fitBestSurface(samplesFor(topology, members), tolerance, angleTolerance) ?? fit;
    const segmentId = segments.length;
    members.forEach((triangle) => {
      assigned[triangle] = segmentId;
    });
    segments.push({
      id: segmentId,
      triangles: members,
      fit: finalFit,
      area: members.reduce((total, triangle) => total + topology.areas[triangle], 0),
    });
  });

  const unassignedTriangles: number[] = [];
  for (let triangle = 0; triangle < topology.triangleCount; triangle += 1) {
    if (assigned[triangle] < 0) unassignedTriangles.push(triangle);
  }

  return { segments, unassignedTriangles };
}

/** Canonical direction for clustering: sign-normalized so ±axis compare equal. */
export function canonicalDirection(direction: Vec3): Vec3 {
  const unit = normalize3(direction);
  const components: [number, number, number] = [unit.x, unit.y, unit.z];
  const dominant = components.reduce(
    (best, value, index) => (Math.abs(value) > Math.abs(components[best]) ? index : best),
    0,
  );
  return components[dominant] < 0 ? { x: -unit.x, y: -unit.y, z: -unit.z } : unit;
}
