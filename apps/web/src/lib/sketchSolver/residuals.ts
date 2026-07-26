// Constraint residuals. Each constraint contributes one or more scalar
// functions that the solver drives to zero.
//
// Every residual is expressed in millimetres. Naturally dimensionless
// quantities (a cross product of unit directions, an angle in radians) are
// multiplied by a characteristic length so a single Levenberg–Marquardt damping
// value is meaningful across the whole system — mixing metres-squared and
// radians in one least-squares problem is the classic way to get a solver that
// converges on some sketches and crawls on others.

import {
  add,
  addConstant,
  constant,
  div,
  hypot,
  mul,
  scale,
  sub,
  type Ad,
} from "@/lib/sketchSolver/autodiff";
import {
  evaluateCenter,
  evaluateLineDirection,
  evaluatePointRef,
  evaluateRadius,
  type AdPoint,
  type AdVector,
  type VariableLayout,
} from "@/lib/sketchSolver/variables";
import type { SketchConstraint, SketchEntity, SketchEntityId } from "@/types/sketch";

const DEGREES_TO_RADIANS = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const MIN_DIRECTION_LENGTH = 1e-9;

export type ResidualRow = { constraintId: string; residual: Ad };

export type UnsupportedConstraint = { constraintId: string; reason: string };

export type ResidualBuild = {
  rows: ResidualRow[];
  unsupported: UnsupportedConstraint[];
};

function dot(a: AdVector, b: AdVector): Ad {
  return add(mul(a.x, b.x), mul(a.y, b.y));
}

function cross(a: AdVector, b: AdVector): Ad {
  return sub(mul(a.x, b.y), mul(a.y, b.x));
}

function difference(a: AdPoint, b: AdPoint): AdVector {
  return { x: sub(a.x, b.x), y: sub(a.y, b.y) };
}

/**
 * Unit direction. A degenerate (zero-length) vector cannot have a meaningful
 * derivative, so it falls back to a constant to keep NaNs out of the Jacobian;
 * the sketch is already broken at that point and the solver will move away.
 */
function normalized(vector: AdVector): AdVector {
  const length = hypot(vector.x, vector.y);
  if (length.value < MIN_DIRECTION_LENGTH) return { x: constant(1), y: constant(0) };
  return { x: div(vector.x, length), y: div(vector.y, length) };
}

function isCircular(entity: SketchEntity | undefined): boolean {
  return entity?.type === "circle" || entity?.type === "arc";
}

/**
 * Builds every residual row for a sketch.
 *
 * `characteristicLength` scales dimensionless residuals into millimetres; the
 * solver passes the sketch's bounding-box diagonal.
 */
export function buildResiduals(
  layout: VariableLayout,
  values: Float64Array,
  constraints: readonly SketchConstraint[],
  characteristicLength: number,
): ResidualBuild {
  const rows: ResidualRow[] = [];
  const unsupported: UnsupportedConstraint[] = [];
  const angularScale = Math.max(characteristicLength, 1e-6);

  const push = (constraintId: string, residual: Ad) => {
    rows.push({ constraintId, residual });
  };
  const reject = (constraintId: string, reason: string) => {
    unsupported.push({ constraintId, reason });
  };

  const lineDirection = (entityId: SketchEntityId) => evaluateLineDirection(layout, values, entityId);
  const lineStart = (entityId: SketchEntityId) => evaluatePointRef(layout, values, { entityId, role: "start" });

  constraints.forEach((constraint) => {
    switch (constraint.type) {
      case "coincident": {
        const a = evaluatePointRef(layout, values, constraint.a);
        const b = evaluatePointRef(layout, values, constraint.b);
        if (!a || !b) return reject(constraint.id, "Coincident needs two valid points");
        push(constraint.id, sub(a.x, b.x));
        push(constraint.id, sub(a.y, b.y));
        return;
      }

      case "fix": {
        const point = evaluatePointRef(layout, values, constraint.point);
        if (!point) return reject(constraint.id, "Fix needs a valid point");
        push(constraint.id, addConstant(point.x, -constraint.at.x));
        push(constraint.id, addConstant(point.y, -constraint.at.y));
        return;
      }

      case "horizontal":
      case "vertical": {
        const direction = lineDirection(constraint.entity);
        if (!direction) return reject(constraint.id, `${constraint.type} applies to lines`);
        // A single component of the direction vector is already in millimetres.
        push(constraint.id, constraint.type === "horizontal" ? direction.y : direction.x);
        return;
      }

      case "parallel":
      case "perpendicular": {
        const a = lineDirection(constraint.a);
        const b = lineDirection(constraint.b);
        if (!a || !b) return reject(constraint.id, `${constraint.type} applies to two lines`);
        const unitA = normalized(a);
        const unitB = normalized(b);
        const value = constraint.type === "parallel" ? cross(unitA, unitB) : dot(unitA, unitB);
        push(constraint.id, scale(value, angularScale));
        return;
      }

      case "equal": {
        const entityA = layout.entities.get(constraint.a);
        const entityB = layout.entities.get(constraint.b);
        if (entityA?.type === "line" && entityB?.type === "line") {
          const a = lineDirection(constraint.a);
          const b = lineDirection(constraint.b);
          if (!a || !b) return reject(constraint.id, "Equal needs two valid lines");
          push(constraint.id, sub(hypot(a.x, a.y), hypot(b.x, b.y)));
          return;
        }
        if (isCircular(entityA) && isCircular(entityB)) {
          const a = evaluateRadius(layout, values, constraint.a);
          const b = evaluateRadius(layout, values, constraint.b);
          if (!a || !b) return reject(constraint.id, "Equal needs two valid radii");
          push(constraint.id, sub(a, b));
          return;
        }
        return reject(constraint.id, "Equal applies to two lines or two circles/arcs");
      }

      case "concentric": {
        const a = evaluateCenter(layout, values, constraint.a);
        const b = evaluateCenter(layout, values, constraint.b);
        if (!a || !b) return reject(constraint.id, "Concentric applies to circles and arcs");
        push(constraint.id, sub(a.x, b.x));
        push(constraint.id, sub(a.y, b.y));
        return;
      }

      case "midpoint": {
        const point = evaluatePointRef(layout, values, constraint.point);
        const start = lineStart(constraint.line);
        const end = evaluatePointRef(layout, values, { entityId: constraint.line, role: "end" });
        if (!point || !start || !end) return reject(constraint.id, "Midpoint needs a point and a line");
        push(constraint.id, sub(point.x, scale(add(start.x, end.x), 0.5)));
        push(constraint.id, sub(point.y, scale(add(start.y, end.y), 0.5)));
        return;
      }

      case "pointOnEntity": {
        const point = evaluatePointRef(layout, values, constraint.point);
        if (!point) return reject(constraint.id, "Point-on needs a valid point");
        const target = layout.entities.get(constraint.entity);
        if (target?.type === "line") {
          const direction = lineDirection(constraint.entity);
          const start = lineStart(constraint.entity);
          if (!direction || !start) return reject(constraint.id, "Point-on needs a valid line");
          push(constraint.id, cross(difference(point, start), normalized(direction)));
          return;
        }
        if (isCircular(target)) {
          const center = evaluateCenter(layout, values, constraint.entity);
          const radius = evaluateRadius(layout, values, constraint.entity);
          if (!center || !radius) return reject(constraint.id, "Point-on needs a valid circle");
          const offset = difference(point, center);
          push(constraint.id, sub(hypot(offset.x, offset.y), radius));
          return;
        }
        return reject(constraint.id, "Point-on applies to lines, circles and arcs");
      }

      case "tangent": {
        const entityA = layout.entities.get(constraint.a);
        const entityB = layout.entities.get(constraint.b);
        const lineId = entityA?.type === "line" ? constraint.a : entityB?.type === "line" ? constraint.b : null;
        const circleId = isCircular(entityA) ? constraint.a : isCircular(entityB) ? constraint.b : null;

        if (lineId && circleId) {
          const direction = lineDirection(lineId);
          const start = lineStart(lineId);
          const center = evaluateCenter(layout, values, circleId);
          const radius = evaluateRadius(layout, values, circleId);
          if (!direction || !start || !center || !radius) return reject(constraint.id, "Tangent needs a line and a circle");
          const signedDistance = cross(difference(center, start), normalized(direction));
          // Pick the side the circle is currently on so the residual stays
          // smooth; the absolute-value form has a kink exactly at the solution.
          const side = signedDistance.value < 0 ? -1 : 1;
          push(constraint.id, sub(signedDistance, scale(radius, side)));
          return;
        }

        if (isCircular(entityA) && isCircular(entityB)) {
          const centerA = evaluateCenter(layout, values, constraint.a);
          const centerB = evaluateCenter(layout, values, constraint.b);
          const radiusA = evaluateRadius(layout, values, constraint.a);
          const radiusB = evaluateRadius(layout, values, constraint.b);
          if (!centerA || !centerB || !radiusA || !radiusB) return reject(constraint.id, "Tangent needs two circles");
          const offset = difference(centerA, centerB);
          const distance = hypot(offset.x, offset.y);
          // External (sum of radii) or internal (difference) tangency, whichever
          // the current configuration is already closer to.
          const externalError = Math.abs(distance.value - (radiusA.value + radiusB.value));
          const internalError = Math.abs(distance.value - Math.abs(radiusA.value - radiusB.value));
          if (externalError <= internalError) {
            push(constraint.id, sub(distance, add(radiusA, radiusB)));
          } else {
            const side = radiusA.value - radiusB.value < 0 ? -1 : 1;
            push(constraint.id, sub(distance, scale(sub(radiusA, radiusB), side)));
          }
          return;
        }

        return reject(constraint.id, "Tangent applies to a line and a circle, or two circles");
      }

      case "symmetric": {
        const a = evaluatePointRef(layout, values, constraint.a);
        const b = evaluatePointRef(layout, values, constraint.b);
        const direction = lineDirection(constraint.axis);
        const start = lineStart(constraint.axis);
        if (!a || !b || !direction || !start) return reject(constraint.id, "Symmetry needs two points and an axis line");
        const unit = normalized(direction);
        const midpoint: AdPoint = { x: scale(add(a.x, b.x), 0.5), y: scale(add(a.y, b.y), 0.5) };
        // Midpoint sits on the axis, and the connecting segment is perpendicular to it.
        push(constraint.id, cross(difference(midpoint, start), unit));
        push(constraint.id, dot(difference(b, a), unit));
        return;
      }

      case "distance": {
        const a = evaluatePointRef(layout, values, constraint.a);
        const b = evaluatePointRef(layout, values, constraint.b);
        if (!a || !b) return reject(constraint.id, "Distance needs two valid points");
        const offset = difference(b, a);
        push(constraint.id, addConstant(hypot(offset.x, offset.y), -constraint.value.value));
        return;
      }

      case "horizontalDistance":
      case "verticalDistance": {
        const a = evaluatePointRef(layout, values, constraint.a);
        const b = evaluatePointRef(layout, values, constraint.b);
        if (!a || !b) return reject(constraint.id, "Distance needs two valid points");
        const delta = constraint.type === "horizontalDistance" ? sub(b.x, a.x) : sub(b.y, a.y);
        push(constraint.id, addConstant(delta, -constraint.value.value));
        return;
      }

      case "pointLineDistance": {
        const point = evaluatePointRef(layout, values, constraint.point);
        const direction = lineDirection(constraint.line);
        const start = lineStart(constraint.line);
        if (!point || !direction || !start) return reject(constraint.id, "Distance needs a point and a line");
        const signedDistance = cross(difference(point, start), normalized(direction));
        const side = signedDistance.value < 0 ? -1 : 1;
        push(constraint.id, addConstant(signedDistance, -side * constraint.value.value));
        return;
      }

      case "radius":
      case "diameter": {
        const radius = evaluateRadius(layout, values, constraint.entity);
        if (!radius) return reject(constraint.id, `${constraint.type} applies to circles and arcs`);
        const target = constraint.type === "radius" ? constraint.value.value : constraint.value.value / 2;
        push(constraint.id, addConstant(radius, -target));
        return;
      }

      case "angle": {
        const a = lineDirection(constraint.a);
        const b = lineDirection(constraint.b);
        if (!a || !b) return reject(constraint.id, "Angle applies to two lines");
        const unitA = normalized(a);
        const unitB = normalized(b);
        const angle = angleBetween(unitA, unitB);
        const target = constraint.value.value * DEGREES_TO_RADIANS;
        // Shift the target by whole turns so the residual is the shortest way
        // round; a constant offset leaves the derivative untouched.
        const turns = Math.round((angle.value - target) / TWO_PI);
        push(constraint.id, scale(addConstant(angle, -(target + turns * TWO_PI)), angularScale));
        return;
      }

      default:
        return reject((constraint as SketchConstraint).id, "Unsupported constraint");
    }
  });

  return { rows, unsupported };
}

/**
 * Signed angle from `a` to `b` as atan2(cross, dot), differentiated directly
 * rather than through acos — acos loses all precision near 0° and 180°, which
 * is exactly where angle dimensions are most often placed.
 */
function angleBetween(a: AdVector, b: AdVector): Ad {
  const crossValue = cross(a, b);
  const dotValue = dot(a, b);
  const denominator = Math.max(crossValue.value * crossValue.value + dotValue.value * dotValue.value, 1e-18);
  const gradient = new Map<number, number>();
  crossValue.grad.forEach((derivative, index) => {
    gradient.set(index, (derivative * dotValue.value) / denominator);
  });
  dotValue.grad.forEach((derivative, index) => {
    const combined = (gradient.get(index) ?? 0) - (derivative * crossValue.value) / denominator;
    if (combined === 0) gradient.delete(index);
    else gradient.set(index, combined);
  });
  return { value: Math.atan2(crossValue.value, dotValue.value), grad: gradient };
}

/** Exported for the residual unit tests, which check it against finite differences. */
export const internals = { angleBetween, normalized, cross, dot };
