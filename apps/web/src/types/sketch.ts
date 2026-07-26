// Data model for the parametric sketcher.
//
// A sketch lives on a plane and holds analytic entities in plane-local (u, v)
// coordinates plus the constraints that drive them. This is deliberately kept
// separate from the legacy freehand `SketchProfile` in `types/sketchforge.ts`:
// old projects keep loading unchanged and are migrated on demand by
// `lib/sketchEntities.ts#legacySketchProfileToSketch`.
//
// Conventions:
//   - lengths are millimetres, matching the rest of SketchForge
//   - entity angles are radians (the solver works in radians)
//   - angle *dimensions* are degrees, because that is what the user types
//   - arcs always sweep counter-clockwise from `startAngle` to `endAngle`

import type { SketchParameter } from "@/lib/parameterExpressions";
import type { SketchImage } from "@/types/sketchforge";

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type SketchEntityId = string;
export type SketchConstraintId = string;

/**
 * Which characteristic point of an entity a constraint refers to.
 *
 * Arc endpoints are derived from (centre, radius, angle) rather than stored, so
 * an arc's endpoints can never drift off its own circle.
 */
export type SketchPointRole = "start" | "end" | "center" | "point";
export type SketchPointRef = { entityId: SketchEntityId; role: SketchPointRole };

type SketchEntityBase = {
  id: SketchEntityId;
  /** Construction geometry drives constraints but never forms a profile. */
  construction?: boolean;
};

export type SketchPointEntity = SketchEntityBase & { type: "point"; p: Vec2 };
export type SketchLineEntity = SketchEntityBase & { type: "line"; a: Vec2; b: Vec2 };
export type SketchCircleEntity = SketchEntityBase & { type: "circle"; c: Vec2; r: number };
export type SketchArcEntity = SketchEntityBase & {
  type: "arc";
  c: Vec2;
  r: number;
  /** Counter-clockwise sweep; `endAngle` is kept greater than `startAngle`. */
  startAngle: number;
  endAngle: number;
};
export type SketchSplineEntity = SketchEntityBase & {
  type: "spline";
  /** Bezier control polygon. The curve interpolates the first and last point. */
  ctrl: Vec2[];
  degree: number;
  periodic?: boolean;
};

export type SketchEntity =
  | SketchPointEntity
  | SketchLineEntity
  | SketchCircleEntity
  | SketchArcEntity
  | SketchSplineEntity;

export type SketchEntityType = SketchEntity["type"];

/**
 * A driving dimension. `expression` is the source of truth and is re-evaluated
 * against the parameter table; `value` caches the last solved result so a sketch
 * renders immediately after load, before parameters have been resolved.
 */
export type SketchDimensionValue = { expression: string; value: number };

type ConstraintBase = { id: SketchConstraintId };
type DimensionBase = ConstraintBase & { value: SketchDimensionValue; label?: Vec2 };

export type SketchConstraint =
  // Geometric constraints
  | (ConstraintBase & { type: "coincident"; a: SketchPointRef; b: SketchPointRef })
  | (ConstraintBase & { type: "pointOnEntity"; point: SketchPointRef; entity: SketchEntityId })
  | (ConstraintBase & { type: "horizontal"; entity: SketchEntityId })
  | (ConstraintBase & { type: "vertical"; entity: SketchEntityId })
  | (ConstraintBase & { type: "parallel"; a: SketchEntityId; b: SketchEntityId })
  | (ConstraintBase & { type: "perpendicular"; a: SketchEntityId; b: SketchEntityId })
  | (ConstraintBase & { type: "equal"; a: SketchEntityId; b: SketchEntityId })
  | (ConstraintBase & { type: "tangent"; a: SketchEntityId; b: SketchEntityId })
  | (ConstraintBase & { type: "concentric"; a: SketchEntityId; b: SketchEntityId })
  | (ConstraintBase & { type: "midpoint"; point: SketchPointRef; line: SketchEntityId })
  | (ConstraintBase & { type: "symmetric"; a: SketchPointRef; b: SketchPointRef; axis: SketchEntityId })
  // `at` is captured when the constraint is applied. Storing the pinned
  // location explicitly keeps the rank accounting honest — including for arc
  // endpoints, which are derived from centre/radius/angle and so have no
  // variables of their own to freeze.
  | (ConstraintBase & { type: "fix"; point: SketchPointRef; at: Vec2 })
  // Driving dimensions
  | (DimensionBase & { type: "distance"; a: SketchPointRef; b: SketchPointRef })
  | (DimensionBase & { type: "horizontalDistance"; a: SketchPointRef; b: SketchPointRef })
  | (DimensionBase & { type: "verticalDistance"; a: SketchPointRef; b: SketchPointRef })
  | (DimensionBase & { type: "pointLineDistance"; point: SketchPointRef; line: SketchEntityId })
  | (DimensionBase & { type: "radius"; entity: SketchEntityId })
  | (DimensionBase & { type: "diameter"; entity: SketchEntityId })
  | (DimensionBase & { type: "angle"; a: SketchEntityId; b: SketchEntityId });

export type SketchConstraintType = SketchConstraint["type"];

export const DIMENSION_CONSTRAINT_TYPES = [
  "distance",
  "horizontalDistance",
  "verticalDistance",
  "pointLineDistance",
  "radius",
  "diameter",
  "angle",
] as const satisfies readonly SketchConstraintType[];

export type SketchDimensionConstraint = Extract<SketchConstraint, { value: SketchDimensionValue }>;

export function isDimensionConstraint(constraint: SketchConstraint): constraint is SketchDimensionConstraint {
  return (DIMENSION_CONSTRAINT_TYPES as readonly string[]).includes(constraint.type);
}

/**
 * An orthonormal frame placing the sketch plane in world space.
 * The plane normal is `xAxis × yAxis`; (u, v) maps to `origin + u·xAxis + v·yAxis`.
 */
export type SketchFrame = { origin: Vec3; xAxis: Vec3; yAxis: Vec3 };

export type BasePlaneName = "xy" | "xz" | "yz";

/**
 * Geometric signature used to re-find a body face after a rebuild.
 *
 * SketchForge has no persistent topological naming, so a face reference is
 * matched by centroid, normal and area. This is the pragmatic industry
 * compromise: it survives ordinary edits and breaks visibly (never silently) on
 * large topology changes, at which point the frozen `frame` is used instead.
 */
export type FaceSignature = { centroid: Vec3; normal: Vec3; area: number };

export type SketchPlaneRef =
  | { kind: "base"; plane: BasePlaneName; offset: number }
  | { kind: "face"; shapeId: string; signature: FaceSignature; frame: SketchFrame };

/** Whether the plane reference still resolves, for the timeline warning badge. */
export type SketchPlaneResolution = "resolved" | "fallback";

export type Sketch = {
  id: string;
  name: string;
  plane: SketchPlaneRef;
  entities: SketchEntity[];
  constraints: SketchConstraint[];
  /** Reference underlays, carried over unchanged from the freehand sketcher. */
  images?: SketchImage[];
  planeResolution?: SketchPlaneResolution;
  /**
   * Named values the sketch's dimensions can refer to.
   *
   * They live on the sketch rather than on the project so they save and load
   * with the body that uses them, instead of being a second thing to remember
   * to send along. Sharing one table across a whole project is the obvious next
   * step and is not built yet.
   */
  parameters?: SketchParameter[];
};
