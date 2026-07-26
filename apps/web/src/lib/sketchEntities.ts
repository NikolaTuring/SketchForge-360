// Geometry helpers for the parametric sketcher: characteristic points, entity
// construction (rectangles, polygons and slots are built from primitives plus
// auto-constraints, exactly as the sketcher's tools do), plane frames, and the
// migration from the legacy freehand `SketchProfile`.

import { createLocalId } from "@/lib/localIds";
import type {
  BasePlaneName,
  Sketch,
  SketchArcEntity,
  SketchCircleEntity,
  SketchConstraint,
  SketchEntity,
  SketchFrame,
  SketchLineEntity,
  SketchPlaneRef,
  SketchPointRef,
  SketchPointRole,
  SketchSplineEntity,
  Vec2,
  Vec3,
} from "@/types/sketch";
import type { SketchProfile } from "@/types/sketchforge";

export const TWO_PI = Math.PI * 2;

export function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

export function addVec2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subVec2(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scaleVec2(a: Vec2, factor: number): Vec2 {
  return { x: a.x * factor, y: a.y * factor };
}

export function lengthVec2(a: Vec2) {
  return Math.hypot(a.x, a.y);
}

export function distanceVec2(a: Vec2, b: Vec2) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Wraps an angle into [0, 2π). */
export function normalizeAngle(angle: number) {
  const wrapped = angle % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * Normalizes an arc so it sweeps counter-clockwise with `endAngle` strictly
 * greater than `startAngle`, which is the invariant the solver and the profile
 * walker both rely on.
 */
export function normalizeArcAngles(startAngle: number, endAngle: number) {
  const start = normalizeAngle(startAngle);
  let end = normalizeAngle(endAngle);
  if (end <= start + 1e-12) end += TWO_PI;
  return { startAngle: start, endAngle: end };
}

export function arcPoint(arc: Pick<SketchArcEntity, "c" | "r">, angle: number): Vec2 {
  return { x: arc.c.x + arc.r * Math.cos(angle), y: arc.c.y + arc.r * Math.sin(angle) };
}

/**
 * The position of one of an entity's characteristic points, or null when the
 * role does not apply (a circle has no start point, for example).
 */
export function entityPoint(entity: SketchEntity, role: SketchPointRole): Vec2 | null {
  switch (entity.type) {
    case "point":
      return role === "point" || role === "start" || role === "end" ? entity.p : null;
    case "line":
      if (role === "start") return entity.a;
      if (role === "end") return entity.b;
      if (role === "center") return scaleVec2(addVec2(entity.a, entity.b), 0.5);
      return null;
    case "circle":
      return role === "center" ? entity.c : null;
    case "arc":
      if (role === "center") return entity.c;
      if (role === "start") return arcPoint(entity, entity.startAngle);
      if (role === "end") return arcPoint(entity, entity.endAngle);
      return null;
    case "spline":
      if (role === "start") return entity.ctrl[0] ?? null;
      if (role === "end") return entity.ctrl[entity.ctrl.length - 1] ?? null;
      return null;
    default:
      return null;
  }
}

export function resolvePointRef(entities: readonly SketchEntity[], ref: SketchPointRef): Vec2 | null {
  const entity = entities.find((candidate) => candidate.id === ref.entityId);
  return entity ? entityPoint(entity, ref.role) : null;
}

/** Roles that actually exist on an entity, for hit-testing and snapping. */
export function entityPointRoles(entity: SketchEntity): SketchPointRole[] {
  switch (entity.type) {
    case "point":
      return ["point"];
    case "line":
      return ["start", "end", "center"];
    case "circle":
      return ["center"];
    case "arc":
      return ["center", "start", "end"];
    case "spline":
      return ["start", "end"];
    default:
      return [];
  }
}

export function pointRef(entityId: string, role: SketchPointRole): SketchPointRef {
  return { entityId, role };
}

export function samePointRef(a: SketchPointRef, b: SketchPointRef) {
  return a.entityId === b.entityId && a.role === b.role;
}

// ---------------------------------------------------------------------------
// Entity construction
// ---------------------------------------------------------------------------

export function createLine(a: Vec2, b: Vec2, construction = false): SketchLineEntity {
  return { id: createLocalId("sk-line"), type: "line", a: { ...a }, b: { ...b }, ...(construction ? { construction } : {}) };
}

export function createCircle(c: Vec2, r: number, construction = false): SketchCircleEntity {
  return { id: createLocalId("sk-circle"), type: "circle", c: { ...c }, r, ...(construction ? { construction } : {}) };
}

export function createArc(c: Vec2, r: number, startAngle: number, endAngle: number, construction = false): SketchArcEntity {
  const angles = normalizeArcAngles(startAngle, endAngle);
  return { id: createLocalId("sk-arc"), type: "arc", c: { ...c }, r, ...angles, ...(construction ? { construction } : {}) };
}

export function createSpline(ctrl: Vec2[], degree = 3, construction = false): SketchSplineEntity {
  return {
    id: createLocalId("sk-spline"),
    type: "spline",
    ctrl: ctrl.map((point) => ({ ...point })),
    degree,
    ...(construction ? { construction } : {}),
  };
}

export function createPoint(p: Vec2, construction = false) {
  return { id: createLocalId("sk-point"), type: "point" as const, p: { ...p }, ...(construction ? { construction } : {}) };
}

function coincident(a: SketchPointRef, b: SketchPointRef): SketchConstraint {
  return { id: createLocalId("sk-con"), type: "coincident", a, b };
}

function horizontal(entityId: string): SketchConstraint {
  return { id: createLocalId("sk-con"), type: "horizontal", entity: entityId };
}

function vertical(entityId: string): SketchConstraint {
  return { id: createLocalId("sk-con"), type: "vertical", entity: entityId };
}

function equal(a: string, b: string): SketchConstraint {
  return { id: createLocalId("sk-con"), type: "equal", a, b };
}

function tangent(a: string, b: string): SketchConstraint {
  return { id: createLocalId("sk-con"), type: "tangent", a, b };
}

export type EntityGroup = { entities: SketchEntity[]; constraints: SketchConstraint[] };

/**
 * A rectangle is four lines closed by coincidences plus horizontal/vertical
 * constraints — the same representation the user would get by drawing it by
 * hand, so every corner stays draggable and dimensionable.
 */
export function rectangleEntities(corner: Vec2, opposite: Vec2, construction = false): EntityGroup {
  const minX = Math.min(corner.x, opposite.x);
  const maxX = Math.max(corner.x, opposite.x);
  const minY = Math.min(corner.y, opposite.y);
  const maxY = Math.max(corner.y, opposite.y);
  const corners: Vec2[] = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];

  const lines = corners.map((start, index) => createLine(start, corners[(index + 1) % corners.length], construction));
  const constraints: SketchConstraint[] = lines.map((line, index) =>
    coincident(pointRef(line.id, "end"), pointRef(lines[(index + 1) % lines.length].id, "start")),
  );
  constraints.push(horizontal(lines[0].id), vertical(lines[1].id), horizontal(lines[2].id), vertical(lines[3].id));

  return { entities: lines, constraints };
}

export function centerRectangleEntities(center: Vec2, corner: Vec2, construction = false): EntityGroup {
  const halfWidth = Math.abs(corner.x - center.x);
  const halfHeight = Math.abs(corner.y - center.y);
  return rectangleEntities(
    { x: center.x - halfWidth, y: center.y - halfHeight },
    { x: center.x + halfWidth, y: center.y + halfHeight },
    construction,
  );
}

/**
 * Regular polygon. `inscribed` places the vertices on the circle (the usual
 * "inscribed" option); otherwise the edge midpoints touch it.
 */
export function polygonEntities(center: Vec2, radius: number, sides: number, inscribed = true, construction = false): EntityGroup {
  const count = Math.max(3, Math.round(sides));
  const effectiveRadius = inscribed ? radius : radius / Math.cos(Math.PI / count);
  const vertices = Array.from({ length: count }, (_unused, index) => {
    const angle = -Math.PI / 2 + (index * TWO_PI) / count;
    return { x: center.x + effectiveRadius * Math.cos(angle), y: center.y + effectiveRadius * Math.sin(angle) };
  });

  const lines = vertices.map((start, index) => createLine(start, vertices[(index + 1) % count], construction));
  const constraints: SketchConstraint[] = lines.map((line, index) =>
    coincident(pointRef(line.id, "end"), pointRef(lines[(index + 1) % count].id, "start")),
  );
  // Equal-length edges keep the polygon regular while it is dragged.
  for (let index = 1; index < lines.length; index += 1) {
    constraints.push(equal(lines[0].id, lines[index].id));
  }

  return { entities: lines, constraints };
}

/**
 * Slot: two parallel lines closed by semicircular end caps, tangent at each join.
 *
 * Arcs are counter-clockwise by invariant, so an end cap that has to bulge
 * *away* from the slot is stored counter-clockwise and simply traversed
 * backwards when the loop is walked. That is why the coincidences below pair
 * end-to-end rather than following one uniform direction around the shape.
 */
export function slotEntities(start: Vec2, end: Vec2, radius: number, construction = false): EntityGroup {
  const axis = subVec2(end, start);
  const axisLength = lengthVec2(axis);
  if (axisLength < 1e-9 || radius <= 1e-9) return { entities: [], constraints: [] };

  const direction = scaleVec2(axis, 1 / axisLength);
  const normal = { x: -direction.y, y: direction.x };
  const offset = scaleVec2(normal, radius);
  const axisAngle = Math.atan2(direction.y, direction.x);
  const quarter = Math.PI / 2;

  // Sweeping through `axisAngle` puts the cap beyond `end`; sweeping through
  // `axisAngle + π` puts the other cap beyond `start`.
  const topLine = createLine(addVec2(start, offset), addVec2(end, offset), construction);
  const endArc = createArc(end, radius, axisAngle - quarter, axisAngle + quarter, construction);
  const bottomLine = createLine(subVec2(end, offset), subVec2(start, offset), construction);
  const startArc = createArc(start, radius, axisAngle + quarter, axisAngle + 3 * quarter, construction);

  const constraints: SketchConstraint[] = [
    coincident(pointRef(topLine.id, "end"), pointRef(endArc.id, "end")),
    coincident(pointRef(endArc.id, "start"), pointRef(bottomLine.id, "start")),
    coincident(pointRef(bottomLine.id, "end"), pointRef(startArc.id, "end")),
    coincident(pointRef(startArc.id, "start"), pointRef(topLine.id, "start")),
    equal(startArc.id, endArc.id),
    tangent(topLine.id, endArc.id),
    tangent(bottomLine.id, startArc.id),
  ];

  return { entities: [topLine, endArc, bottomLine, startArc], constraints };
}

/**
 * Arc through three points. Returns null when the points are collinear, which is
 * the caller's cue to fall back to a straight line.
 */
export function arcThroughThreePoints(start: Vec2, through: Vec2, end: Vec2, construction = false): SketchArcEntity | null {
  const area = (through.x - start.x) * (end.y - start.y) - (through.y - start.y) * (end.x - start.x);
  if (Math.abs(area) < 1e-12) return null;

  const startSq = start.x * start.x + start.y * start.y;
  const throughSq = through.x * through.x + through.y * through.y;
  const endSq = end.x * end.x + end.y * end.y;
  const denominator = 2 * (start.x * (through.y - end.y) + through.x * (end.y - start.y) + end.x * (start.y - through.y));
  if (Math.abs(denominator) < 1e-12) return null;

  const center = {
    x: (startSq * (through.y - end.y) + throughSq * (end.y - start.y) + endSq * (start.y - through.y)) / denominator,
    y: (startSq * (end.x - through.x) + throughSq * (start.x - end.x) + endSq * (through.x - start.x)) / denominator,
  };
  const radius = distanceVec2(center, start);
  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const throughAngle = Math.atan2(through.y - center.y, through.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);

  // Sweep counter-clockwise; if the middle point is not inside that sweep the
  // arc runs the other way, so swap the endpoints to keep the CCW invariant.
  const ccwSweep = normalizeAngle(endAngle - startAngle);
  const ccwThrough = normalizeAngle(throughAngle - startAngle);
  return ccwThrough < ccwSweep
    ? createArc(center, radius, startAngle, endAngle, construction)
    : createArc(center, radius, endAngle, startAngle, construction);
}

// ---------------------------------------------------------------------------
// Plane frames
// ---------------------------------------------------------------------------

// SketchForge is Y-up. Each base plane is right-handed with its normal pointing
// the way a user considers "out of" that plane — +Z for the front plane, +Y for
// the ground plane, +X for the right plane. That invariant is what makes a
// positive extrude distance grow away from the plane instead of into the model.
//
// It is why the ground plane's second axis is −Z rather than +Z: `xAxis × yAxis`
// has to come out as +Y. Sketch v therefore runs opposite to world z on this
// plane, which the legacy migration accounts for.
const BASE_PLANE_FRAMES: Record<BasePlaneName, SketchFrame> = {
  xy: { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 } },
  xz: { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 0, z: -1 } },
  yz: { origin: { x: 0, y: 0, z: 0 }, xAxis: { x: 0, y: 0, z: -1 }, yAxis: { x: 0, y: 1, z: 0 } },
};

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function dotVec3(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalizeVec3(a: Vec3): Vec3 {
  const length = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / length, y: a.y / length, z: a.z / length };
}

export function frameNormal(frame: SketchFrame): Vec3 {
  return normalizeVec3(crossVec3(frame.xAxis, frame.yAxis));
}

/** Builds an orthonormal frame for a plane given its normal and origin. */
export function frameFromNormal(origin: Vec3, normal: Vec3): SketchFrame {
  const unitNormal = normalizeVec3(normal);
  // Pick the world axis least aligned with the normal so the cross product is
  // numerically well conditioned.
  const seed: Vec3 = Math.abs(unitNormal.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const xAxis = normalizeVec3(crossVec3(seed, unitNormal));
  const yAxis = normalizeVec3(crossVec3(unitNormal, xAxis));
  return { origin, xAxis, yAxis };
}

export function sketchFrame(plane: SketchPlaneRef): SketchFrame {
  if (plane.kind === "face") return plane.frame;
  const base = BASE_PLANE_FRAMES[plane.plane];
  const normal = frameNormal(base);
  return {
    origin: {
      x: base.origin.x + normal.x * plane.offset,
      y: base.origin.y + normal.y * plane.offset,
      z: base.origin.z + normal.z * plane.offset,
    },
    xAxis: base.xAxis,
    yAxis: base.yAxis,
  };
}

export function sketchPointToWorld(frame: SketchFrame, point: Vec2): Vec3 {
  return {
    x: frame.origin.x + frame.xAxis.x * point.x + frame.yAxis.x * point.y,
    y: frame.origin.y + frame.xAxis.y * point.x + frame.yAxis.y * point.y,
    z: frame.origin.z + frame.xAxis.z * point.x + frame.yAxis.z * point.y,
  };
}

export function worldPointToSketch(frame: SketchFrame, point: Vec3): Vec2 {
  const relative = { x: point.x - frame.origin.x, y: point.y - frame.origin.y, z: point.z - frame.origin.z };
  return { x: dotVec3(relative, frame.xAxis), y: dotVec3(relative, frame.yAxis) };
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Converts a freehand `SketchProfile` into the parametric model.
 *
 * Straight segments become lines and curved ones become cubic splines through
 * their stored handles. Shared endpoints become coincident constraints, which is
 * the part that actually carries meaning: it preserves the chain topology so the
 * profile stays closed while the user drags it. Nothing else is constrained, so
 * the degrees-of-freedom counter tells the truth about an imported sketch rather
 * than claiming it is fully defined.
 *
 * Legacy sketches live on the ground plane in (x, z). Sketch v runs opposite to
 * world z there (see `BASE_PLANE_FRAMES`), so z is negated on the way in and the
 * geometry lands exactly where it always was.
 */
export function legacySketchProfileToSketch(
  profile: SketchProfile,
  options: { id?: string; name?: string; plane?: SketchPlaneRef } = {},
): Sketch {
  const legacyPoints = new Map(profile.points.map((point) => [point.id, point]));
  const entities: SketchEntity[] = [];
  const constraints: SketchConstraint[] = [];
  // Every endpoint that a legacy point id maps to, so shared points become
  // coincidences no matter how the segments were ordered.
  const endpointsByLegacyId = new Map<string, SketchPointRef[]>();

  const recordEndpoint = (legacyId: string, ref: SketchPointRef) => {
    const existing = endpointsByLegacyId.get(legacyId) ?? [];
    existing.push(ref);
    endpointsByLegacyId.set(legacyId, existing);
  };

  profile.segments.forEach((segment) => {
    const start = legacyPoints.get(segment.startId);
    const end = legacyPoints.get(segment.endId);
    if (!start || !end) return;

    const startPoint = vec2(start.x, -start.z);
    const endPoint = vec2(end.x, -end.z);

    if (segment.kind === "line" || !segment.kind) {
      const line = createLine(startPoint, endPoint);
      entities.push(line);
      recordEndpoint(segment.startId, pointRef(line.id, "start"));
      recordEndpoint(segment.endId, pointRef(line.id, "end"));
      return;
    }

    // Bezier and smooth segments both store cubic handles on their endpoints.
    const outHandle = start.handleOut ? vec2(start.handleOut.x, -start.handleOut.z) : startPoint;
    const inHandle = end.handleIn ? vec2(end.handleIn.x, -end.handleIn.z) : endPoint;
    const spline = createSpline([startPoint, outHandle, inHandle, endPoint], 3);
    entities.push(spline);
    recordEndpoint(segment.startId, pointRef(spline.id, "start"));
    recordEndpoint(segment.endId, pointRef(spline.id, "end"));
  });

  // Isolated legacy points with no segment still carry intent (a centre mark, a
  // leftover node), so keep them as sketch points.
  const usedLegacyIds = new Set(profile.segments.flatMap((segment) => [segment.startId, segment.endId]));
  profile.points.forEach((point) => {
    if (usedLegacyIds.has(point.id)) return;
    entities.push(createPoint(vec2(point.x, -point.z)));
  });

  endpointsByLegacyId.forEach((refs) => {
    for (let index = 1; index < refs.length; index += 1) {
      constraints.push(coincident(refs[0], refs[index]));
    }
  });

  return {
    id: options.id ?? createLocalId("sketch"),
    name: options.name ?? "Sketch",
    plane: options.plane ?? { kind: "base", plane: "xz", offset: 0 },
    entities,
    constraints,
    ...(profile.images?.length ? { images: profile.images } : {}),
  };
}

/** Constraints that no longer reference a live entity, so callers can prune. */
export function danglingConstraintIds(sketch: Sketch): string[] {
  const known = new Set(sketch.entities.map((entity) => entity.id));
  const referencedIds = (constraint: SketchConstraint): string[] => {
    switch (constraint.type) {
      case "coincident":
      case "symmetric":
        return [constraint.a.entityId, constraint.b.entityId, ...(constraint.type === "symmetric" ? [constraint.axis] : [])];
      case "distance":
      case "horizontalDistance":
      case "verticalDistance":
        return [constraint.a.entityId, constraint.b.entityId];
      case "pointOnEntity":
        return [constraint.point.entityId, constraint.entity];
      case "midpoint":
        return [constraint.point.entityId, constraint.line];
      case "pointLineDistance":
        return [constraint.point.entityId, constraint.line];
      case "fix":
        return [constraint.point.entityId];
      case "horizontal":
      case "vertical":
        return [constraint.entity];
      case "radius":
      case "diameter":
        return [constraint.entity];
      default:
        return [constraint.a, constraint.b];
    }
  };

  return sketch.constraints
    .filter((constraint) => referencedIds(constraint).some((id) => !known.has(id)))
    .map((constraint) => constraint.id);
}
