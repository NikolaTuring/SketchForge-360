// The sketch drawing state machine.
//
// Kept out of the component because "what does the next click do" is the part
// of a sketcher people actually feel, and it is far easier to get right with
// tests than by clicking. The component owns pixels and pointers; this owns the
// answer to "click here, now what".
//
// Every tool is described by how many points it needs and what it builds from
// them, so adding one is a table entry rather than another branch in a pointer
// handler.

import {
  addVec2,
  arcThroughThreePoints,
  centerRectangleEntities,
  createArc,
  createCircle,
  createLine,
  createPoint,
  distanceVec2,
  pointRef,
  polygonEntities,
  rectangleEntities,
  slotEntities,
  subVec2,
  vec2,
} from "@/lib/sketchEntities";
import type { SketchConstraint, SketchEntity, SketchEntityId, Vec2 } from "@/types/sketch";

export const DRAW_TOOLS = [
  "line",
  "rectangle",
  "center-rectangle",
  "circle",
  "circle-3p",
  "arc-3p",
  "polygon",
  "slot",
  "point",
] as const;

export const MODIFY_TOOLS = ["trim", "extend", "offset", "fillet", "mirror"] as const;

export type SketchDrawTool = (typeof DRAW_TOOLS)[number];
export type SketchModifyTool = (typeof MODIFY_TOOLS)[number];
export type SketchTool = "select" | SketchDrawTool | SketchModifyTool;

export function isDrawTool(tool: SketchTool): tool is SketchDrawTool {
  return (DRAW_TOOLS as readonly string[]).includes(tool);
}

export function isModifyTool(tool: SketchTool): tool is SketchModifyTool {
  return (MODIFY_TOOLS as readonly string[]).includes(tool);
}

/** How many clicks each drawing tool needs before it produces geometry. */
export const TOOL_POINT_COUNT: Record<SketchDrawTool, number> = {
  line: 2,
  rectangle: 2,
  "center-rectangle": 2,
  circle: 2,
  "circle-3p": 3,
  "arc-3p": 3,
  polygon: 2,
  slot: 3,
  point: 1,
};

/**
 * Points collected so far for the tool in progress.
 *
 * `chainFrom` is the line the next segment continues from, so a chained
 * outline gets a real coincidence rather than two lines that merely touch.
 */
export type SketchDraft = { tool: SketchDrawTool; points: Vec2[]; chainFrom?: SketchEntityId };

export type SketchGeometry = { entities: SketchEntity[]; constraints: SketchConstraint[] };

export type DrawOptions = {
  /** Sides for the polygon tool. */
  polygonSides?: number;
  construction?: boolean;
};

/**
 * Builds the geometry a completed tool produces.
 *
 * Returns null when the points are degenerate — two clicks in the same place,
 * three collinear points for an arc. Refusing is better than emitting a
 * zero-length entity, which is invisible on screen and breaks region detection
 * later with an error that points nowhere near the click that caused it.
 */
export function buildToolGeometry(
  tool: SketchDrawTool,
  points: readonly Vec2[],
  nextId: () => SketchEntityId,
  options: DrawOptions = {},
): SketchGeometry | null {
  const construction = options.construction ?? false;
  const withIds = (geometry: { entities: SketchEntity[]; constraints: SketchConstraint[] }): SketchGeometry => {
    // The constructors mint their own ids; remap them so a session's ids stay
    // under one counter and remain stable across a rebuild.
    const idMap = new Map<string, string>();
    const entities = geometry.entities.map((entity) => {
      const id = nextId();
      idMap.set(entity.id, id);
      return { ...entity, id };
    });
    const constraints = geometry.constraints.map((constraint) => remapConstraint(constraint, idMap, nextId()));
    return { entities, constraints };
  };

  switch (tool) {
    case "point": {
      if (points.length < 1) return null;
      return { entities: [{ ...createPoint(points[0], construction), id: nextId() }], constraints: [] };
    }
    case "line": {
      if (points.length < 2 || distanceVec2(points[0], points[1]) < 1e-7) return null;
      return { entities: [{ ...createLine(points[0], points[1], construction), id: nextId() }], constraints: [] };
    }
    case "rectangle": {
      if (points.length < 2) return null;
      const [corner, opposite] = points;
      if (Math.abs(corner.x - opposite.x) < 1e-7 || Math.abs(corner.y - opposite.y) < 1e-7) return null;
      return withIds(rectangleEntities(corner, opposite, construction));
    }
    case "center-rectangle": {
      if (points.length < 2) return null;
      const [center, corner] = points;
      if (Math.abs(center.x - corner.x) < 1e-7 || Math.abs(center.y - corner.y) < 1e-7) return null;
      return withIds(centerRectangleEntities(center, corner, construction));
    }
    case "circle": {
      if (points.length < 2) return null;
      const radius = distanceVec2(points[0], points[1]);
      if (radius < 1e-7) return null;
      return { entities: [{ ...createCircle(points[0], radius, construction), id: nextId() }], constraints: [] };
    }
    case "circle-3p": {
      if (points.length < 3) return null;
      const circle = circleThroughThreePoints(points[0], points[1], points[2]);
      if (!circle) return null;
      return { entities: [{ ...createCircle(circle.c, circle.r, construction), id: nextId() }], constraints: [] };
    }
    case "arc-3p": {
      if (points.length < 3) return null;
      const arc = arcThroughThreePoints(points[0], points[1], points[2], construction);
      if (!arc) return null;
      return { entities: [{ ...arc, id: nextId() }], constraints: [] };
    }
    case "polygon": {
      if (points.length < 2) return null;
      const radius = distanceVec2(points[0], points[1]);
      if (radius < 1e-7) return null;
      const sides = Math.max(3, Math.min(64, Math.round(options.polygonSides ?? 6)));
      return withIds(polygonEntities(points[0], radius, sides, true, construction));
    }
    case "slot": {
      if (points.length < 3) return null;
      const [start, end, edge] = points;
      if (distanceVec2(start, end) < 1e-7) return null;
      // The third click sets the width: its distance from the slot's own axis.
      const axis = subVec2(end, start);
      const length = Math.hypot(axis.x, axis.y);
      const normal = vec2(-axis.y / length, axis.x / length);
      const offset = subVec2(edge, start);
      const radius = Math.abs(offset.x * normal.x + offset.y * normal.y);
      if (radius < 1e-7) return null;
      return withIds(slotEntities(start, end, radius, construction));
    }
    default:
      return null;
  }
}

/** Rewrites a constraint's entity references through an id map. */
function remapConstraint(constraint: SketchConstraint, idMap: Map<string, string>, id: string): SketchConstraint {
  const entity = (value: string) => idMap.get(value) ?? value;
  const point = (ref: { entityId: string; role: string }) => ({ ...ref, entityId: entity(ref.entityId) });

  const next = { ...constraint, id } as SketchConstraint & Record<string, unknown>;
  if ("entity" in next && typeof next.entity === "string") next.entity = entity(next.entity);
  if ("line" in next && typeof next.line === "string") next.line = entity(next.line);
  if ("axis" in next && typeof next.axis === "string") next.axis = entity(next.axis);
  if ("point" in next && next.point && typeof next.point === "object") next.point = point(next.point as never);
  (["a", "b"] as const).forEach((key) => {
    const value = next[key];
    if (typeof value === "string") next[key] = entity(value);
    else if (value && typeof value === "object" && "entityId" in value) next[key] = point(value as never);
  });
  return next as SketchConstraint;
}

function circleThroughThreePoints(a: Vec2, b: Vec2, c: Vec2): { c: Vec2; r: number } | null {
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  // Collinear points have no circumscribed circle; a huge one is not an answer.
  if (Math.abs(area) < 1e-12) return null;
  const aSquared = a.x * a.x + a.y * a.y;
  const bSquared = b.x * b.x + b.y * b.y;
  const cSquared = c.x * c.x + c.y * c.y;
  const center = vec2(
    (aSquared * (b.y - c.y) + bSquared * (c.y - a.y) + cSquared * (a.y - b.y)) / (2 * area),
    (aSquared * (c.x - b.x) + bSquared * (a.x - c.x) + cSquared * (b.x - a.x)) / (2 * area),
  );
  return { c: center, r: distanceVec2(center, a) };
}

export type ClickResult = {
  draft: SketchDraft | null;
  geometry: SketchGeometry | null;
  /** True when the tool should stay armed for another shape. */
  repeat: boolean;
};

/**
 * Feeds a click into the drawing state machine.
 *
 * The line tool chains: after finishing one segment the next click continues
 * from its end, which is how anyone draws an outline. Every other tool starts
 * fresh, because a chained rectangle means nothing.
 */
export function clickDrawTool(
  tool: SketchDrawTool,
  draft: SketchDraft | null,
  point: Vec2,
  nextId: () => SketchEntityId,
  options: DrawOptions = {},
): ClickResult {
  const current = draft && draft.tool === tool ? draft.points : [];
  const chain = draft && draft.tool === tool ? draft.chainFrom : undefined;
  const points = [...current, point];
  const needed = TOOL_POINT_COUNT[tool];

  if (points.length < needed) {
    return { draft: { tool, points, chainFrom: chain }, geometry: null, repeat: true };
  }

  const geometry = buildToolGeometry(tool, points, nextId, options);
  if (!geometry) {
    // Degenerate input: drop the last click rather than the whole draft, so a
    // misclick costs one click instead of restarting the shape.
    return { draft: { tool, points: current, chainFrom: chain }, geometry: null, repeat: true };
  }

  if (tool === "line") {
    const segment = geometry.entities[0];
    // Join the new segment to the previous one. Without this the chain looks
    // connected and comes apart the moment anything is dragged — and region
    // detection would then find no closed loop at all.
    if (chain) {
      geometry.constraints.push({
        id: nextId(),
        type: "coincident",
        a: pointRef(chain, "end"),
        b: pointRef(segment.id, "start"),
      });
    }
    // The next click continues from this endpoint, which is how anyone draws an
    // outline. Every other tool starts fresh, because a chained rectangle means
    // nothing.
    return { draft: { tool, points: [point], chainFrom: segment.id }, geometry, repeat: true };
  }

  return { draft: null, geometry, repeat: true };
}

/**
 * Snaps a point onto the grid, or leaves it alone when snapping is off.
 *
 * Snapping happens at the click, not at the solve: a snapped click becomes a
 * real coordinate the user can then constrain, whereas snapping during the
 * solve would fight every dimension they add.
 */
export function snapPoint(point: Vec2, step: number): Vec2 {
  if (!Number.isFinite(step) || step <= 0) return point;
  return vec2(Math.round(point.x / step) * step, Math.round(point.y / step) * step);
}

export type SnapCandidate = {
  point: Vec2;
  kind: "endpoint" | "center" | "midpoint";
  entityId: SketchEntityId;
};

/**
 * Characteristic points worth snapping to, within `radius` of `target`.
 *
 * Ordered nearest-first. Endpoints and centres come from the entities
 * themselves, so a snap lands exactly on the geometry rather than near it —
 * which is the difference between a profile that closes and one that does not.
 */
export function snapCandidates(
  entities: readonly SketchEntity[],
  target: Vec2,
  radius: number,
): SnapCandidate[] {
  const found: SnapCandidate[] = [];
  entities.forEach((entity) => {
    if (entity.type === "line") {
      found.push({ point: entity.a, kind: "endpoint", entityId: entity.id });
      found.push({ point: entity.b, kind: "endpoint", entityId: entity.id });
      found.push({ point: addVec2(entity.a, { x: (entity.b.x - entity.a.x) / 2, y: (entity.b.y - entity.a.y) / 2 }), kind: "midpoint", entityId: entity.id });
    } else if (entity.type === "circle" || entity.type === "arc") {
      found.push({ point: entity.c, kind: "center", entityId: entity.id });
    } else if (entity.type === "point") {
      found.push({ point: entity.p, kind: "endpoint", entityId: entity.id });
    }
  });

  return found
    .filter((candidate) => distanceVec2(candidate.point, target) <= radius)
    .sort((left, right) => distanceVec2(left.point, target) - distanceVec2(right.point, target));
}

/**
 * Preview geometry for a tool mid-draw, so the shape follows the cursor.
 *
 * Built from the same function that produces the committed geometry, so what is
 * shown and what is created cannot disagree.
 */
export function draftPreview(
  draft: SketchDraft | null,
  cursor: Vec2,
  options: DrawOptions = {},
): SketchEntity[] {
  if (!draft) return [];
  let preview = 0;
  const previewId = () => {
    preview += 1;
    return `preview-${preview}`;
  };
  const geometry = buildToolGeometry(draft.tool, [...draft.points, cursor], previewId, options);
  if (geometry) return geometry.entities;

  // Not enough points for the real shape yet: show the rubber band so the user
  // can still see what the clicks so far mean.
  if (draft.points.length >= 1 && draft.tool !== "point") {
    return [{ ...createLine(draft.points[draft.points.length - 1], cursor, true), id: previewId() }];
  }
  return [];
}

/** Removes constraints that name an entity which no longer exists. */
export function pruneConstraints(
  constraints: readonly SketchConstraint[],
  entities: readonly SketchEntity[],
): SketchConstraint[] {
  const live = new Set(entities.map((entity) => entity.id));
  const names = (constraint: SketchConstraint): string[] => {
    const ids: string[] = [];
    const record = constraint as Record<string, unknown>;
    ["entity", "line", "axis"].forEach((key) => {
      if (typeof record[key] === "string") ids.push(record[key] as string);
    });
    ["a", "b", "point"].forEach((key) => {
      const value = record[key];
      if (typeof value === "string") ids.push(value);
      else if (value && typeof value === "object" && "entityId" in value) ids.push((value as { entityId: string }).entityId);
    });
    return ids;
  };
  return constraints.filter((constraint) => names(constraint).every((id) => live.has(id)));
}
