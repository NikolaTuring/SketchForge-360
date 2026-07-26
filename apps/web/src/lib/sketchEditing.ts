// Editing sketch geometry: trim, extend, offset, fillet, mirror and patterns.
//
// Everything here is analytic. Trimming a line at a circle produces a shorter
// line, not a polyline that happens to stop near the circle — the whole point of
// the parametric sketcher is that the geometry stays exact all the way to the
// kernel, and a "trim" that discretised would quietly throw that away.
//
// The module is deliberately pure: entities in, entities out, no solver and no
// kernel. That makes every case here unit-testable, which matters because the
// intersection maths is where this kind of code goes wrong — and it goes wrong
// silently, as geometry that looks right and is a few microns off.

import {
  TWO_PI,
  addVec2,
  arcPoint,
  createArc,
  createCircle,
  createLine,
  distanceVec2,
  lengthVec2,
  normalizeAngle,
  scaleVec2,
  subVec2,
  vec2,
} from "@/lib/sketchEntities";
import type {
  SketchArcEntity,
  SketchCircleEntity,
  SketchEntity,
  SketchEntityId,
  SketchLineEntity,
  Vec2,
} from "@/types/sketch";

/** Below this two points are the same point, in millimetres. */
export const EDIT_TOLERANCE = 1e-7;

/**
 * How far outside its own range a parameter may stray and still count as on the
 * entity. A hair wider than the point tolerance, because an intersection solved
 * from two directions lands on either side of an endpoint.
 */
const PARAMETER_EPSILON = 1e-9;

export type Intersection = {
  point: Vec2;
  /** Parameter on the first entity: 0..1 on a line, an angle on an arc or circle. */
  tA: number;
  /** Parameter on the second entity. */
  tB: number;
};

function isLine(entity: SketchEntity): entity is SketchLineEntity {
  return entity.type === "line";
}

function isCircular(entity: SketchEntity): entity is SketchCircleEntity | SketchArcEntity {
  return entity.type === "circle" || entity.type === "arc";
}

/** Whether a parameter lies within the entity's own extent. */
function onEntity(entity: SketchEntity, parameter: number): boolean {
  if (entity.type === "line") return parameter >= -PARAMETER_EPSILON && parameter <= 1 + PARAMETER_EPSILON;
  if (entity.type === "circle") return true;
  if (entity.type === "arc") {
    // Arcs sweep counter-clockwise from `startAngle`, and `endAngle` is kept
    // greater, so the test is on the sweep offset rather than on the raw angle.
    const sweep = entity.endAngle - entity.startAngle;
    const offset = normalizeAngle(parameter - entity.startAngle);
    return offset <= sweep + PARAMETER_EPSILON || sweep >= TWO_PI - PARAMETER_EPSILON;
  }
  return false;
}

function linePoint(line: SketchLineEntity, t: number): Vec2 {
  return vec2(line.a.x + (line.b.x - line.a.x) * t, line.a.y + (line.b.y - line.a.y) * t);
}

function lineLineIntersections(a: SketchLineEntity, b: SketchLineEntity): Intersection[] {
  const ua = subVec2(a.b, a.a);
  const ub = subVec2(b.b, b.a);
  const denominator = ua.x * ub.y - ua.y * ub.x;
  // Parallel — including collinear, which has infinitely many crossings and so
  // no single answer worth reporting.
  if (Math.abs(denominator) < 1e-12) return [];

  const delta = subVec2(b.a, a.a);
  const tA = (delta.x * ub.y - delta.y * ub.x) / denominator;
  const tB = (delta.x * ua.y - delta.y * ua.x) / denominator;
  return [{ point: linePoint(a, tA), tA, tB }];
}

function lineCircleIntersections(line: SketchLineEntity, circle: SketchCircleEntity | SketchArcEntity): Intersection[] {
  const direction = subVec2(line.b, line.a);
  const toStart = subVec2(line.a, circle.c);
  const a = direction.x * direction.x + direction.y * direction.y;
  if (a < 1e-24) return [];
  const b = 2 * (toStart.x * direction.x + toStart.y * direction.y);
  const c = toStart.x * toStart.x + toStart.y * toStart.y - circle.r * circle.r;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];

  // A tangent line touches once. Treating it as two coincident roots would
  // report a zero-length segment between them, which every caller then has to
  // filter out again.
  const roots = discriminant < 1e-18 ? [-b / (2 * a)] : [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)];

  return roots.map((t) => {
    const point = linePoint(line, t);
    return { point, tA: t, tB: Math.atan2(point.y - circle.c.y, point.x - circle.c.x) };
  });
}

function circleCircleIntersections(
  a: SketchCircleEntity | SketchArcEntity,
  b: SketchCircleEntity | SketchArcEntity,
): Intersection[] {
  const between = subVec2(b.c, a.c);
  const distance = lengthVec2(between);
  // Concentric circles either never meet or coincide entirely; neither has a
  // discrete answer.
  if (distance < 1e-12) return [];
  if (distance > a.r + b.r + 1e-12) return [];
  if (distance < Math.abs(a.r - b.r) - 1e-12) return [];

  const along = (distance * distance + a.r * a.r - b.r * b.r) / (2 * distance);
  const heightSquared = a.r * a.r - along * along;
  const height = heightSquared > 0 ? Math.sqrt(heightSquared) : 0;
  const unit = scaleVec2(between, 1 / distance);
  const base = addVec2(a.c, scaleVec2(unit, along));
  const normal = vec2(-unit.y, unit.x);

  const points = height < 1e-9 ? [base] : [addVec2(base, scaleVec2(normal, height)), addVec2(base, scaleVec2(normal, -height))];
  return points.map((point) => ({
    point,
    tA: Math.atan2(point.y - a.c.y, point.x - a.c.x),
    tB: Math.atan2(point.y - b.c.y, point.x - b.c.x),
  }));
}

/**
 * Where two entities cross, with the parameter on each.
 *
 * Only crossings that lie on both entities' actual extents are returned: two
 * arcs whose full circles intersect but whose sweeps do not are not touching,
 * and reporting the phantom crossing would let a trim delete geometry at a
 * point the user cannot see.
 */
export function intersectEntities(a: SketchEntity, b: SketchEntity): Intersection[] {
  let raw: Intersection[];
  if (isLine(a) && isLine(b)) raw = lineLineIntersections(a, b);
  else if (isLine(a) && isCircular(b)) raw = lineCircleIntersections(a, b);
  else if (isCircular(a) && isLine(b)) {
    raw = lineCircleIntersections(b, a).map((hit) => ({ point: hit.point, tA: hit.tB, tB: hit.tA }));
  } else if (isCircular(a) && isCircular(b)) raw = circleCircleIntersections(a, b);
  else return [];

  return raw.filter((hit) => onEntity(a, hit.tA) && onEntity(b, hit.tB));
}

/** Parameter of the point on an entity nearest to `target`. */
export function parameterAt(entity: SketchEntity, target: Vec2): number {
  if (entity.type === "line") {
    const direction = subVec2(entity.b, entity.a);
    const lengthSquared = direction.x * direction.x + direction.y * direction.y;
    if (lengthSquared < 1e-24) return 0;
    const offset = subVec2(target, entity.a);
    return (offset.x * direction.x + offset.y * direction.y) / lengthSquared;
  }
  if (entity.type === "circle" || entity.type === "arc") {
    return Math.atan2(target.y - entity.c.y, target.x - entity.c.x);
  }
  return 0;
}

/**
 * Splits an entity at the given parameters.
 *
 * A circle split once stays whole — one cut cannot open a closed curve — which
 * is why trimming a circle needs two crossings and is a no-op with one.
 */
export function splitEntity(entity: SketchEntity, parameters: readonly number[], nextId: () => SketchEntityId): SketchEntity[] {
  if (entity.type === "line") {
    const cuts = [...parameters]
      .filter((t) => t > PARAMETER_EPSILON && t < 1 - PARAMETER_EPSILON)
      .sort((left, right) => left - right);
    if (cuts.length === 0) return [entity];

    const bounds = [0, ...cuts, 1];
    return bounds.slice(0, -1).map((from, index) => {
      const to = bounds[index + 1];
      const piece = createLine(linePoint(entity, from), linePoint(entity, to), entity.construction);
      // The first piece keeps the original id, so constraints that name this
      // entity survive a trim of the far end.
      return index === 0 ? { ...piece, id: entity.id } : { ...piece, id: nextId() };
    });
  }

  if (entity.type === "arc") {
    const sweep = entity.endAngle - entity.startAngle;
    const offsets = [...parameters]
      .map((angle) => normalizeAngle(angle - entity.startAngle))
      .filter((offset) => offset > PARAMETER_EPSILON && offset < sweep - PARAMETER_EPSILON)
      .sort((left, right) => left - right);
    if (offsets.length === 0) return [entity];

    const bounds = [0, ...offsets, sweep];
    return bounds.slice(0, -1).map((from, index) => {
      const to = bounds[index + 1];
      const piece = createArc(entity.c, entity.r, entity.startAngle + from, entity.startAngle + to, entity.construction);
      return index === 0 ? { ...piece, id: entity.id } : { ...piece, id: nextId() };
    });
  }

  if (entity.type === "circle") {
    const angles = [...parameters].map(normalizeAngle).sort((left, right) => left - right);
    // One cut leaves a full circle: opening a closed curve takes two.
    if (angles.length < 2) return [entity];
    return angles.map((angle, index) => {
      const next = index === angles.length - 1 ? angles[0] + TWO_PI : angles[index + 1];
      const piece = createArc(entity.c, entity.r, angle, next, entity.construction);
      return index === 0 ? { ...piece, id: entity.id } : { ...piece, id: nextId() };
    });
  }

  return [entity];
}

export type SketchEdit = {
  entities: SketchEntity[];
  /** Entities that no longer exist, so their constraints can be dropped. */
  removedIds: SketchEntityId[];
};

/**
 * Trims the piece of `targetId` under the cursor, back to its nearest crossings.
 *
 * "The piece under the cursor" is what makes trim feel direct: the user points
 * at the bit they want gone rather than naming boundaries. With no crossing on
 * one side the entity's own end is the boundary, and with none on either side
 * the whole entity goes — which is what someone pointing at a stray line means.
 */
export function trimEntity(
  entities: readonly SketchEntity[],
  targetId: SketchEntityId,
  at: Vec2,
  nextId: () => SketchEntityId,
): SketchEdit {
  const target = entities.find((entity) => entity.id === targetId);
  if (!target || target.type === "point" || target.type === "spline") {
    return { entities: [...entities], removedIds: [] };
  }

  const crossings = entities
    .filter((entity) => entity.id !== targetId)
    .flatMap((entity) => intersectEntities(target, entity).map((hit) => hit.tA));

  const pieces = splitEntity(target, crossings, nextId);
  if (pieces.length === 1) {
    // Nothing crosses it: the whole entity is the piece being pointed at.
    return { entities: entities.filter((entity) => entity.id !== targetId), removedIds: [targetId] };
  }

  const doomed = nearestPiece(pieces, at);
  const kept = pieces.filter((piece) => piece.id !== doomed.id);
  const keptIds = new Set(kept.map((piece) => piece.id));

  const next: SketchEntity[] = [];
  entities.forEach((entity) => {
    if (entity.id !== targetId) {
      next.push(entity);
      return;
    }
    next.push(...kept);
  });

  return {
    entities: next,
    // Only the original id counts as removed; the extra pieces were never in
    // the sketch, so no constraint can name them.
    removedIds: keptIds.has(targetId) ? [] : [targetId],
  };
}

function nearestPiece(pieces: readonly SketchEntity[], at: Vec2): SketchEntity {
  let best = pieces[0];
  let bestDistance = Infinity;
  pieces.forEach((piece) => {
    const distance = distanceToEntity(piece, at);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = piece;
    }
  });
  return best;
}

/** Distance from a point to an entity, clamped to the entity's own extent. */
export function distanceToEntity(entity: SketchEntity, target: Vec2): number {
  if (entity.type === "point") return distanceVec2(entity.p, target);
  if (entity.type === "line") {
    const t = Math.max(0, Math.min(1, parameterAt(entity, target)));
    return distanceVec2(linePoint(entity, t), target);
  }
  if (entity.type === "circle") return Math.abs(distanceVec2(entity.c, target) - entity.r);
  if (entity.type === "arc") {
    const angle = parameterAt(entity, target);
    if (onEntity(entity, angle)) return Math.abs(distanceVec2(entity.c, target) - entity.r);
    // Outside the sweep the nearest point is whichever endpoint is closer.
    return Math.min(
      distanceVec2(arcPoint(entity, entity.startAngle), target),
      distanceVec2(arcPoint(entity, entity.endAngle), target),
    );
  }
  // Splines are sampled by their control polygon, which is close enough for
  // picking and never used for a geometric result.
  return Math.min(...entity.ctrl.map((control) => distanceVec2(control, target)));
}

/**
 * Extends `targetId` from the end nearest `at` to the first entity it reaches.
 *
 * Only crossings beyond the entity's own extent count, and the nearest one
 * wins: extending past the first thing in the way would need the user to say
 * how far, which is what a dimension is for.
 */
export function extendEntity(
  entities: readonly SketchEntity[],
  targetId: SketchEntityId,
  at: Vec2,
  nextId: () => SketchEntityId,
): SketchEdit {
  void nextId;
  const target = entities.find((entity) => entity.id === targetId);
  if (!target) return { entities: [...entities], removedIds: [] };

  const others = entities.filter((entity) => entity.id !== targetId);

  if (target.type === "line") {
    const fromStart = parameterAt(target, at) < 0.5;
    let best: number | null = null;
    others.forEach((other) => {
      // The unbounded line, so a crossing past the endpoint is visible at all.
      const infinite: SketchLineEntity = {
        ...target,
        a: linePoint(target, -1e4),
        b: linePoint(target, 1e4),
      };
      intersectEntities(infinite, other).forEach((hit) => {
        // Map the parameter on the extended line back onto the original.
        const t = -1e4 + hit.tA * 2e4;
        const beyond = fromStart ? t < -PARAMETER_EPSILON : t > 1 + PARAMETER_EPSILON;
        if (!beyond) return;
        if (best === null) best = t;
        else if (fromStart ? t > best : t < best) best = t;
      });
    });
    if (best === null) return { entities: [...entities], removedIds: [] };

    const extended = fromStart
      ? createLine(linePoint(target, best), target.b, target.construction)
      : createLine(target.a, linePoint(target, best), target.construction);
    return {
      entities: entities.map((entity) => (entity.id === targetId ? { ...extended, id: targetId } : entity)),
      removedIds: [],
    };
  }

  if (target.type === "arc") {
    const fromStart = normalizeAngle(parameterAt(target, at) - target.startAngle) < (target.endAngle - target.startAngle) / 2;
    const full = createCircle(target.c, target.r);
    let best: number | null = null;
    others.forEach((other) => {
      intersectEntities(full, other).forEach((hit) => {
        const offset = normalizeAngle(hit.tA - target.startAngle);
        const sweep = target.endAngle - target.startAngle;
        if (offset <= sweep + PARAMETER_EPSILON) return;
        // Distance travelled to reach the crossing, in the direction of growth.
        const travel = fromStart ? TWO_PI - offset : offset - sweep;
        if (best === null || travel < best) best = travel;
      });
    });
    if (best === null) return { entities: [...entities], removedIds: [] };

    const extended = fromStart
      ? createArc(target.c, target.r, target.startAngle - best, target.endAngle, target.construction)
      : createArc(target.c, target.r, target.startAngle, target.endAngle + best, target.construction);
    return {
      entities: entities.map((entity) => (entity.id === targetId ? { ...extended, id: targetId } : entity)),
      removedIds: [],
    };
  }

  return { entities: [...entities], removedIds: [] };
}

/**
 * Offsets entities by a signed distance.
 *
 * Each entity is offset on its own: a proper offset of a chain would also have
 * to trim and fillet the corners, and a partial job that silently left gaps
 * would be worse than one the user can see and close themselves.
 */
export function offsetEntities(
  entities: readonly SketchEntity[],
  distance: number,
  nextId: () => SketchEntityId,
): SketchEntity[] {
  if (Math.abs(distance) < EDIT_TOLERANCE) return entities.map((entity) => ({ ...entity, id: nextId() }));

  return entities.flatMap((entity): SketchEntity[] => {
    if (entity.type === "line") {
      const direction = subVec2(entity.b, entity.a);
      const length = lengthVec2(direction);
      if (length < EDIT_TOLERANCE) return [];
      // Left-hand normal, so a positive distance offsets consistently along a
      // counter-clockwise chain.
      const normal = scaleVec2(vec2(-direction.y / length, direction.x / length), distance);
      return [{ ...createLine(addVec2(entity.a, normal), addVec2(entity.b, normal), entity.construction), id: nextId() }];
    }
    if (entity.type === "circle") {
      const radius = entity.r + distance;
      // A circle offset inward past its own centre has no geometry left.
      if (radius <= EDIT_TOLERANCE) return [];
      return [{ ...createCircle(entity.c, radius, entity.construction), id: nextId() }];
    }
    if (entity.type === "arc") {
      const radius = entity.r + distance;
      if (radius <= EDIT_TOLERANCE) return [];
      return [{ ...createArc(entity.c, radius, entity.startAngle, entity.endAngle, entity.construction), id: nextId() }];
    }
    return [];
  });
}

/** Mirrors a point across the line through `a` and `b`. */
export function mirrorPoint(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const axis = subVec2(b, a);
  const lengthSquared = axis.x * axis.x + axis.y * axis.y;
  if (lengthSquared < 1e-24) return { ...point };
  const offset = subVec2(point, a);
  const projection = (offset.x * axis.x + offset.y * axis.y) / lengthSquared;
  const foot = addVec2(a, scaleVec2(axis, projection));
  return vec2(2 * foot.x - point.x, 2 * foot.y - point.y);
}

/**
 * Mirrors entities across an axis.
 *
 * Reflection reverses handedness, so an arc's counter-clockwise sweep becomes
 * clockwise. The mirrored arc is rebuilt with its endpoints swapped rather than
 * its angles negated, which is what keeps it on the same side of its chord.
 */
export function mirrorEntities(
  entities: readonly SketchEntity[],
  axisA: Vec2,
  axisB: Vec2,
  nextId: () => SketchEntityId,
): SketchEntity[] {
  const reflect = (point: Vec2) => mirrorPoint(point, axisA, axisB);

  return entities.flatMap((entity): SketchEntity[] => {
    if (entity.type === "line") {
      return [{ ...createLine(reflect(entity.a), reflect(entity.b), entity.construction), id: nextId() }];
    }
    if (entity.type === "circle") {
      return [{ ...createCircle(reflect(entity.c), entity.r, entity.construction), id: nextId() }];
    }
    if (entity.type === "arc") {
      const center = reflect(entity.c);
      const start = reflect(arcPoint(entity, entity.startAngle));
      const end = reflect(arcPoint(entity, entity.endAngle));
      const startAngle = Math.atan2(end.y - center.y, end.x - center.x);
      const endAngle = Math.atan2(start.y - center.y, start.x - center.x);
      return [{ ...createArc(center, entity.r, startAngle, endAngle, entity.construction), id: nextId() }];
    }
    if (entity.type === "point") {
      return [{ ...entity, id: nextId(), p: reflect(entity.p) }];
    }
    return [{ ...entity, id: nextId(), ctrl: entity.ctrl.map(reflect) }];
  });
}

function translateEntity(entity: SketchEntity, offset: Vec2, id: SketchEntityId): SketchEntity {
  if (entity.type === "line") return { ...entity, id, a: addVec2(entity.a, offset), b: addVec2(entity.b, offset) };
  if (entity.type === "circle" || entity.type === "arc") return { ...entity, id, c: addVec2(entity.c, offset) };
  if (entity.type === "point") return { ...entity, id, p: addVec2(entity.p, offset) };
  return { ...entity, id, ctrl: entity.ctrl.map((control) => addVec2(control, offset)) };
}

export type RectangularPattern = {
  /** Direction and spacing of the first axis. */
  step: Vec2;
  count: number;
  /** Optional second axis. */
  step2?: Vec2;
  count2?: number;
};

/**
 * Repeats entities on a grid.
 *
 * The original occupies slot (0, 0) and is not duplicated, so a pattern of
 * three gives three items rather than four.
 */
export function rectangularPattern(
  entities: readonly SketchEntity[],
  pattern: RectangularPattern,
  nextId: () => SketchEntityId,
): SketchEntity[] {
  const countX = Math.max(1, Math.floor(pattern.count));
  const countY = Math.max(1, Math.floor(pattern.count2 ?? 1));
  const step2 = pattern.step2 ?? vec2(0, 0);

  const copies: SketchEntity[] = [];
  for (let row = 0; row < countY; row += 1) {
    for (let column = 0; column < countX; column += 1) {
      if (row === 0 && column === 0) continue;
      const offset = vec2(
        pattern.step.x * column + step2.x * row,
        pattern.step.y * column + step2.y * row,
      );
      entities.forEach((entity) => copies.push(translateEntity(entity, offset, nextId())));
    }
  }
  return copies;
}

function rotatePoint(point: Vec2, center: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offset = subVec2(point, center);
  return vec2(center.x + offset.x * cos - offset.y * sin, center.y + offset.x * sin + offset.y * cos);
}

function rotateEntity(entity: SketchEntity, center: Vec2, angle: number, id: SketchEntityId): SketchEntity {
  if (entity.type === "line") {
    return { ...entity, id, a: rotatePoint(entity.a, center, angle), b: rotatePoint(entity.b, center, angle) };
  }
  if (entity.type === "circle") return { ...entity, id, c: rotatePoint(entity.c, center, angle) };
  if (entity.type === "arc") {
    // Rotation preserves handedness, so the sweep simply rotates with it.
    return {
      ...entity,
      id,
      c: rotatePoint(entity.c, center, angle),
      startAngle: entity.startAngle + angle,
      endAngle: entity.endAngle + angle,
    };
  }
  if (entity.type === "point") return { ...entity, id, p: rotatePoint(entity.p, center, angle) };
  return { ...entity, id, ctrl: entity.ctrl.map((control) => rotatePoint(control, center, angle)) };
}

export type CircularPattern = {
  center: Vec2;
  count: number;
  /** Total sweep in radians. A full turn spaces copies evenly around it. */
  totalAngle?: number;
};

/**
 * Repeats entities around a centre.
 *
 * A full turn divides by the count so the first and last copy do not land on
 * top of each other; a partial sweep divides by count − 1 so the last copy sits
 * exactly on the far end, which is what someone typing 90° means.
 */
export function circularPattern(
  entities: readonly SketchEntity[],
  pattern: CircularPattern,
  nextId: () => SketchEntityId,
): SketchEntity[] {
  const count = Math.max(1, Math.floor(pattern.count));
  if (count < 2) return [];
  const total = pattern.totalAngle ?? TWO_PI;
  const full = Math.abs(Math.abs(total) - TWO_PI) < 1e-9;
  const step = full ? total / count : total / (count - 1);

  const copies: SketchEntity[] = [];
  for (let index = 1; index < count; index += 1) {
    entities.forEach((entity) => copies.push(rotateEntity(entity, pattern.center, step * index, nextId())));
  }
  return copies;
}

export type FilletResult = SketchEdit & { arcId: SketchEntityId | null };

/**
 * Rounds the corner between two lines with an arc of the given radius.
 *
 * Both lines are shortened to the arc's tangent points, so the result is a
 * closed chain rather than three pieces that nearly meet. A radius that does not
 * fit — one longer than either leg — is refused rather than clamped: silently
 * using a different radius than the one typed is the kind of help that costs an
 * hour to notice.
 */
export function filletLines(
  entities: readonly SketchEntity[],
  firstId: SketchEntityId,
  secondId: SketchEntityId,
  radius: number,
  nextId: () => SketchEntityId,
): FilletResult {
  const unchanged: FilletResult = { entities: [...entities], removedIds: [], arcId: null };
  const first = entities.find((entity) => entity.id === firstId);
  const second = entities.find((entity) => entity.id === secondId);
  if (!first || !second || !isLine(first) || !isLine(second) || radius <= EDIT_TOLERANCE) return unchanged;

  const [crossing] = lineLineIntersections(first, second);
  if (!crossing) return unchanged;
  const corner = crossing.point;

  // Point each leg away from the corner, choosing the end that is further from
  // it — that is the end that survives.
  const legOf = (line: SketchLineEntity) => {
    const far = distanceVec2(line.a, corner) > distanceVec2(line.b, corner) ? line.a : line.b;
    const direction = subVec2(far, corner);
    const length = lengthVec2(direction);
    return { far, unit: scaleVec2(direction, 1 / length), length };
  };

  const legA = legOf(first);
  const legB = legOf(second);
  if (legA.length < EDIT_TOLERANCE || legB.length < EDIT_TOLERANCE) return unchanged;

  const cosine = legA.unit.x * legB.unit.x + legA.unit.y * legB.unit.y;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  // Parallel or doubled-back legs have no corner to round.
  if (angle < 1e-6 || Math.PI - angle < 1e-6) return unchanged;

  const setback = radius / Math.tan(angle / 2);
  if (setback > legA.length - EDIT_TOLERANCE || setback > legB.length - EDIT_TOLERANCE) return unchanged;

  const tangentA = addVec2(corner, scaleVec2(legA.unit, setback));
  const tangentB = addVec2(corner, scaleVec2(legB.unit, setback));

  // The arc centre sits along the angle bisector, at the distance that puts it
  // exactly `radius` from both legs.
  const bisector = addVec2(legA.unit, legB.unit);
  const bisectorLength = lengthVec2(bisector);
  if (bisectorLength < 1e-9) return unchanged;
  const center = addVec2(corner, scaleVec2(bisector, radius / Math.sin(angle / 2) / bisectorLength));

  const angleA = Math.atan2(tangentA.y - center.y, tangentA.x - center.x);
  const angleB = Math.atan2(tangentB.y - center.y, tangentB.x - center.x);
  // Arcs are stored counter-clockwise, so the shorter of the two possible
  // sweeps decides which endpoint starts it.
  const sweep = normalizeAngle(angleB - angleA);
  const arc = sweep <= Math.PI
    ? createArc(center, radius, angleA, angleA + sweep)
    : createArc(center, radius, angleB, angleB + (TWO_PI - sweep));
  const arcId = nextId();

  const shorten = (line: SketchLineEntity, leg: { far: Vec2 }, tangent: Vec2): SketchLineEntity => ({
    ...createLine(leg.far, tangent, line.construction),
    id: line.id,
  });

  const next = entities.map((entity) => {
    if (entity.id === firstId) return shorten(first, legA, tangentA);
    if (entity.id === secondId) return shorten(second, legB, tangentB);
    return entity;
  });

  return { entities: [...next, { ...arc, id: arcId }], removedIds: [], arcId };
}
