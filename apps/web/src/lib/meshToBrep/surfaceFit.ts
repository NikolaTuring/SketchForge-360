// Least-squares fitting of analytic surfaces to a patch of mesh triangles.
//
// This is the step that turns "a few hundred triangles" back into "a cylinder of
// radius 5 about this axis". Each fit reports its worst-case deviation so the
// caller can accept or reject it against a user-facing tolerance rather than
// trusting a shape it cannot verify.
//
// Fits are weighted by triangle area: a tessellation puts many small triangles
// where a surface curves and few large ones where it is flat, and unweighted
// fitting would let the dense regions dominate.

import { createMatrix, solveLeastSquares } from "@/lib/sketchSolver/linalg";
import type { Vec3 } from "@/lib/meshToBrep/meshTopology";

export type SurfaceKind = "plane" | "cylinder" | "cone" | "sphere";

export type PlaneSurface = { kind: "plane"; normal: Vec3; distance: number };
export type CylinderSurface = { kind: "cylinder"; axis: Vec3; point: Vec3; radius: number };
export type ConeSurface = { kind: "cone"; axis: Vec3; apex: Vec3; halfAngle: number };
export type SphereSurface = { kind: "sphere"; center: Vec3; radius: number };

export type AnalyticSurface = PlaneSurface | CylinderSurface | ConeSurface | SphereSurface;

export type SurfaceFit = {
  surface: AnalyticSurface;
  /** Largest absolute distance from a sample to the fitted surface, in mm. */
  maxDeviation: number;
  /** Area-weighted RMS distance, used to break ties between candidate kinds. */
  rmsDeviation: number;
  /**
   * Largest angle between a sample normal and the fitted surface's normal, in
   * degrees.
   *
   * This is not a refinement — it is what makes recognition possible at all.
   * The eight corners of a box lie *exactly* on a circumscribing cylinder, so
   * point distance alone cannot tell a box face from a cylinder. The normals
   * can: a box face's normal is constant, a cylinder's rotates.
   */
  maxNormalDeviation: number;
};

export type FitSample = { point: Vec3; normal: Vec3; weight: number };

const EPSILON = 1e-12;

function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function length3(a: Vec3) {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize3(a: Vec3): Vec3 {
  const magnitude = length3(a);
  return magnitude < EPSILON ? { x: 0, y: 0, z: 1 } : { x: a.x / magnitude, y: a.y / magnitude, z: a.z / magnitude };
}

function weightedCentroid(samples: readonly FitSample[]): { centroid: Vec3; totalWeight: number } {
  let totalWeight = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  samples.forEach((sample) => {
    totalWeight += sample.weight;
    x += sample.point.x * sample.weight;
    y += sample.point.y * sample.weight;
    z += sample.point.z * sample.weight;
  });
  if (totalWeight < EPSILON) return { centroid: { x: 0, y: 0, z: 0 }, totalWeight: 0 };
  return { centroid: { x: x / totalWeight, y: y / totalWeight, z: z / totalWeight }, totalWeight };
}

/**
 * Eigen-decomposition of a symmetric 3×3 matrix by cyclic Jacobi rotations.
 *
 * Used for both plane fitting (smallest eigenvector of the point covariance) and
 * cylinder axis recovery (smallest eigenvector of the normal covariance). Jacobi
 * is chosen over a closed-form cubic solve because it stays accurate when two
 * eigenvalues are nearly equal, which is exactly the case for a surface of
 * revolution.
 */
export function symmetricEigen3(matrix: readonly number[]): { values: number[]; vectors: Vec3[] } {
  const a = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[1], matrix[3], matrix[4]],
    [matrix[2], matrix[4], matrix[5]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 64; sweep += 1) {
    let offDiagonal = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (offDiagonal < 1e-16) break;

    for (let p = 0; p < 2; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const sign = theta >= 0 ? 1 : -1;
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < 3; k += 1) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k += 1) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
    offDiagonal = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
  }

  const entries = [0, 1, 2]
    .map((index) => ({
      value: a[index][index],
      vector: { x: v[0][index], y: v[1][index], z: v[2][index] } as Vec3,
    }))
    .sort((left, right) => left.value - right.value);

  return { values: entries.map((entry) => entry.value), vectors: entries.map((entry) => normalize3(entry.vector)) };
}

function covarianceOf(samples: readonly FitSample[], pick: (sample: FitSample) => Vec3, center: Vec3) {
  const moments = [0, 0, 0, 0, 0, 0];
  samples.forEach((sample) => {
    const d = subtract(pick(sample), center);
    moments[0] += sample.weight * d.x * d.x;
    moments[1] += sample.weight * d.x * d.y;
    moments[2] += sample.weight * d.x * d.z;
    moments[3] += sample.weight * d.y * d.y;
    moments[4] += sample.weight * d.y * d.z;
    moments[5] += sample.weight * d.z * d.z;
  });
  return moments;
}

/**
 * Measures how well a finished surface explains the samples, in both position
 * and orientation.
 *
 * Normals are compared unsigned: an STL with inconsistently wound triangles is
 * common, and a surface that matches apart from a flipped facet is still the
 * right surface.
 */
function evaluateFit(surface: AnalyticSurface, samples: readonly FitSample[]): SurfaceFit {
  let maxDeviation = 0;
  let maxNormalDeviation = 0;
  let weighted = 0;
  let totalWeight = 0;

  samples.forEach((sample) => {
    const deviation = Math.abs(distanceToSurface(surface, sample.point));
    if (deviation > maxDeviation) maxDeviation = deviation;
    weighted += sample.weight * deviation * deviation;
    totalWeight += sample.weight;

    // Skip singular points; they carry no orientation information.
    const expected = surfaceNormalAt(surface, sample.point);
    if (expected) {
      const alignment = Math.min(1, Math.abs(dot(expected, sample.normal)));
      const angle = (Math.acos(alignment) * 180) / Math.PI;
      if (angle > maxNormalDeviation) maxNormalDeviation = angle;
    }
  });

  return {
    surface,
    maxDeviation,
    rmsDeviation: totalWeight > 0 ? Math.sqrt(weighted / totalWeight) : 0,
    maxNormalDeviation,
  };
}

export function fitPlane(samples: readonly FitSample[]): SurfaceFit | null {
  if (samples.length < 3) return null;
  const { centroid, totalWeight } = weightedCentroid(samples);
  if (totalWeight <= 0) return null;

  const { vectors } = symmetricEigen3(covarianceOf(samples, (sample) => sample.point, centroid));
  let normal = vectors[0];

  // Orient the plane with the mesh so the resulting face points outward.
  const averageNormal = samples.reduce(
    (total, sample) => ({
      x: total.x + sample.normal.x * sample.weight,
      y: total.y + sample.normal.y * sample.weight,
      z: total.z + sample.normal.z * sample.weight,
    }),
    { x: 0, y: 0, z: 0 },
  );
  if (dot(normal, averageNormal) < 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };

  return evaluateFit({ kind: "plane", normal, distance: dot(normal, centroid) }, samples);
}

export function fitSphere(samples: readonly FitSample[]): SurfaceFit | null {
  if (samples.length < 4) return null;

  // |p|² = 2p·c + (r² − |c|²) is linear in (c, k), so one least-squares solve
  // gives an excellent starting estimate without any iteration.
  const matrix = createMatrix(samples.length, 4);
  const rhs = new Float64Array(samples.length);
  samples.forEach((sample, row) => {
    const weight = Math.sqrt(sample.weight);
    matrix.data[row * 4] = 2 * sample.point.x * weight;
    matrix.data[row * 4 + 1] = 2 * sample.point.y * weight;
    matrix.data[row * 4 + 2] = 2 * sample.point.z * weight;
    matrix.data[row * 4 + 3] = weight;
    rhs[row] = (sample.point.x ** 2 + sample.point.y ** 2 + sample.point.z ** 2) * weight;
  });

  const solution = solveLeastSquares(matrix, rhs);
  if (!solution) return null;

  const center = { x: solution[0], y: solution[1], z: solution[2] };
  const radiusSquared = solution[3] + center.x ** 2 + center.y ** 2 + center.z ** 2;
  if (!(radiusSquared > EPSILON)) return null;
  return evaluateFit({ kind: "sphere", center, radius: Math.sqrt(radiusSquared) }, samples);
}

/**
 * Fits a cylinder using the Gauss-map property: every normal of a cylinder is
 * perpendicular to its axis, so the normals lie on a great circle and the axis
 * is the direction of least variance in the normal cloud.
 */
export function fitCylinder(samples: readonly FitSample[]): SurfaceFit | null {
  if (samples.length < 6) return null;

  const { values, vectors } = symmetricEigen3(covarianceOf(samples, (sample) => sample.normal, { x: 0, y: 0, z: 0 }));
  const axis = normalize3(vectors[0]);

  // A real cylinder's normals sweep a great circle, so the two non-axis
  // eigenvalues are both substantial. On a flat patch they collapse and the
  // "axis" is an arbitrary direction in the plane — the circle fit that follows
  // would then return a meaningless enormous radius.
  if (!(values[1] > values[2] * 1e-4)) return null;

  // Project into the plane perpendicular to the axis and fit a circle there.
  const reference: Vec3 = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize3(cross(reference, axis));
  const w = normalize3(cross(axis, u));

  const matrix = createMatrix(samples.length, 3);
  const rhs = new Float64Array(samples.length);
  samples.forEach((sample, row) => {
    const weight = Math.sqrt(sample.weight);
    const su = dot(sample.point, u);
    const sw = dot(sample.point, w);
    matrix.data[row * 3] = 2 * su * weight;
    matrix.data[row * 3 + 1] = 2 * sw * weight;
    matrix.data[row * 3 + 2] = weight;
    rhs[row] = (su * su + sw * sw) * weight;
  });

  const solution = solveLeastSquares(matrix, rhs);
  if (!solution) return null;

  const centerU = solution[0];
  const centerW = solution[1];
  const radiusSquared = solution[2] + centerU * centerU + centerW * centerW;
  if (!(radiusSquared > EPSILON)) return null;
  const radius = Math.sqrt(radiusSquared);

  const point: Vec3 = {
    x: u.x * centerU + w.x * centerW,
    y: u.y * centerU + w.y * centerW,
    z: u.z * centerU + w.z * centerW,
  };

  return evaluateFit({ kind: "cylinder", axis, point, radius }, samples);
}

/**
 * Fits a cone using the same Gauss-map idea one step further: the normals of a
 * cone lie on a *plane* offset from the origin, `n·axis = sin(halfAngle)`, so a
 * plane fit of the normal cloud recovers both the axis and the half angle.
 */
export function fitCone(samples: readonly FitSample[]): SurfaceFit | null {
  if (samples.length < 6) return null;

  const matrix = createMatrix(samples.length, 4);
  const rhs = new Float64Array(samples.length);
  samples.forEach((sample, row) => {
    const weight = Math.sqrt(sample.weight);
    matrix.data[row * 4] = sample.normal.x * weight;
    matrix.data[row * 4 + 1] = sample.normal.y * weight;
    matrix.data[row * 4 + 2] = sample.normal.z * weight;
    matrix.data[row * 4 + 3] = -weight;
    rhs[row] = 0;
  });
  // The homogeneous system needs an anchor, so pin the plane offset and solve
  // for the axis direction relative to it, then renormalize.
  const anchored = createMatrix(samples.length + 1, 4);
  anchored.data.set(matrix.data, 0);
  anchored.data[samples.length * 4 + 3] = 1;
  const anchoredRhs = new Float64Array(samples.length + 1);
  anchoredRhs[samples.length] = 1;

  const solution = solveLeastSquares(anchored, anchoredRhs);
  if (!solution) return null;

  const rawAxis = { x: solution[0], y: solution[1], z: solution[2] };
  const axisLength = length3(rawAxis);
  if (axisLength < EPSILON) return null;
  let axis = normalize3(rawAxis);
  const sinHalfAngle = Math.max(-1, Math.min(1, Math.abs(solution[3]) / axisLength));
  const halfAngle = Math.asin(sinHalfAngle);

  // A degenerate half angle means the patch is really a plane or a cylinder;
  // those fits describe it better and with fewer parameters.
  if (Math.abs(halfAngle) < 1e-3 || Math.abs(Math.abs(halfAngle) - Math.PI / 2) < 1e-3) return null;

  const tangent = Math.tan(halfAngle);
  if (Math.abs(tangent) < EPSILON) return null;

  const { centroid } = weightedCentroid(samples);

  // The plane fit above leaves the axis sign undetermined, but the apex formula
  // needs it: the axis has to point from the apex toward the widening base, so
  // that distance along it grows together with the radius. Orient it by that
  // correlation rather than trusting the solver's arbitrary choice.
  let correlation = 0;
  samples.forEach((sample) => {
    const offset = subtract(sample.point, centroid);
    const along = dot(offset, axis);
    const radial = length3(subtract(offset, { x: axis.x * along, y: axis.y * along, z: axis.z * along }));
    correlation += sample.weight * along * radial;
  });
  if (correlation < 0) axis = { x: -axis.x, y: -axis.y, z: -axis.z };

  let apexOffset = 0;
  let totalWeight = 0;
  samples.forEach((sample) => {
    const offset = subtract(sample.point, centroid);
    const along = dot(offset, axis);
    const radial = length3(subtract(offset, { x: axis.x * along, y: axis.y * along, z: axis.z * along }));
    apexOffset += sample.weight * (along - radial / tangent);
    totalWeight += sample.weight;
  });
  if (totalWeight <= 0) return null;
  apexOffset /= totalWeight;

  const apex: Vec3 = {
    x: centroid.x + axis.x * apexOffset,
    y: centroid.y + axis.y * apexOffset,
    z: centroid.z + axis.z * apexOffset,
  };

  return evaluateFit({ kind: "cone", axis, apex, halfAngle }, samples);
}

/** Signed distance from a point to a surface; the sign follows the normal. */
export function distanceToSurface(surface: AnalyticSurface, point: Vec3): number {
  switch (surface.kind) {
    case "plane":
      return dot(surface.normal, point) - surface.distance;
    case "sphere":
      return length3(subtract(point, surface.center)) - surface.radius;
    case "cylinder": {
      const offset = subtract(point, surface.point);
      const along = dot(offset, surface.axis);
      const radial = subtract(offset, { x: surface.axis.x * along, y: surface.axis.y * along, z: surface.axis.z * along });
      return length3(radial) - surface.radius;
    }
    case "cone": {
      const offset = subtract(point, surface.apex);
      const along = dot(offset, surface.axis);
      const radial = subtract(offset, { x: surface.axis.x * along, y: surface.axis.y * along, z: surface.axis.z * along });
      return (length3(radial) - along * Math.tan(surface.halfAngle)) * Math.cos(surface.halfAngle);
    }
    default:
      return Infinity;
  }
}

/**
 * Outward unit normal of the surface at a point, or null where the surface has
 * no defined normal.
 *
 * The singular points are real, not edge cases to paper over: a cone's apex and
 * any point on a cylinder's or cone's axis have no unique normal. Every triangle
 * of a tessellated cone shares its apex vertex, so silently substituting a
 * fallback direction there would make an otherwise perfect cone fit look 87°
 * wrong and get it rejected.
 */
export function surfaceNormalAt(surface: AnalyticSurface, point: Vec3): Vec3 | null {
  switch (surface.kind) {
    case "plane":
      return surface.normal;
    case "sphere": {
      const offset = subtract(point, surface.center);
      return length3(offset) < EPSILON ? null : normalize3(offset);
    }
    case "cylinder": {
      const offset = subtract(point, surface.point);
      const along = dot(offset, surface.axis);
      const radial = subtract(offset, { x: surface.axis.x * along, y: surface.axis.y * along, z: surface.axis.z * along });
      return length3(radial) < EPSILON ? null : normalize3(radial);
    }
    case "cone": {
      const offset = subtract(point, surface.apex);
      const along = dot(offset, surface.axis);
      const radialVector = subtract(offset, { x: surface.axis.x * along, y: surface.axis.y * along, z: surface.axis.z * along });
      if (length3(radialVector) < EPSILON) return null;
      const radial = normalize3(radialVector);
      // Tilt the radial direction toward the axis by the half angle.
      const sin = Math.sin(surface.halfAngle);
      const cos = Math.cos(surface.halfAngle);
      return normalize3({
        x: radial.x * cos - surface.axis.x * sin,
        y: radial.y * cos - surface.axis.y * sin,
        z: radial.z * cos - surface.axis.z * sin,
      });
    }
    default:
      return null;
  }
}

/**
 * Picks the best analytic surface for a patch.
 *
 * Simpler kinds win ties by a deliberate margin: a slightly curved plane is far
 * more likely to be a plane with tessellation noise than a cylinder of enormous
 * radius, and the simpler answer is the one that regularizes cleanly.
 */
export function fitBestSurface(samples: readonly FitSample[], tolerance: number, angleTolerance = 15): SurfaceFit | null {
  const candidates: (SurfaceFit | null)[] = [fitPlane(samples), fitCylinder(samples), fitCone(samples), fitSphere(samples)];
  const penalties: Record<SurfaceKind, number> = { plane: 1, cylinder: 1.35, cone: 1.7, sphere: 1.7 };

  let best: SurfaceFit | null = null;
  let bestScore = Infinity;

  candidates.forEach((candidate) => {
    if (!candidate || candidate.maxDeviation > tolerance) return;
    if (candidate.maxNormalDeviation > angleTolerance) return;
    // Guard against fits that technically pass but describe something absurd.
    const surface = candidate.surface;
    if (surface.kind === "cylinder" && !(surface.radius > tolerance)) return;
    if (surface.kind === "sphere" && !(surface.radius > tolerance)) return;

    const score = (candidate.rmsDeviation + tolerance * 1e-3) * penalties[surface.kind];
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  });

  return best;
}
