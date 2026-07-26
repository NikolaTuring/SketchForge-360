// Closed-region detection for sketches.
//
// Turns a set of sketch entities into the regions a user can select and
// extrude, and — crucially — reports each region as a loop of *whole entities*
// rather than a polygon. Keeping the analytic entity behind every loop segment
// is what lets `brepSketchFeatures` build an exact B-Rep with real circular
// edges instead of a many-sided polygon.
//
// Design note: entities are never split implicitly. The sketcher's tools build
// profiles by joining entities end to end (rectangle, polygon, slot, chained
// lines and arcs), and crossings are resolved explicitly with Trim and Extend,
// which replace the crossing entities with new ones. So the region finder walks
// a graph whose nodes are welded endpoints and whose edges are entire entities.
// Geometry that crosses without a shared endpoint is reported as an issue —
// the same "close the profile first" feedback a CAD user expects — instead of
// being silently reinterpreted.

import { findSketchOutlineIntersection } from "@/lib/sketchProfileValidation";
import { TWO_PI, normalizeAngle } from "@/lib/sketchEntities";
import type { SketchEntity, SketchEntityId, Vec2 } from "@/types/sketch";

export type SketchLoopSegment = {
  entityId: SketchEntityId;
  /** True when the loop traverses the entity from its end point to its start. */
  reversed: boolean;
};

export type SketchLoop = {
  segments: SketchLoopSegment[];
  /** Counter-clockwise polyline approximation, used for area and containment. */
  points: Vec2[];
  /** Signed area of `points`; positive means counter-clockwise. */
  area: number;
};

export type SketchRegion = {
  id: string;
  outerLoop: SketchLoop;
  /** Loops enclosed directly by `outerLoop`; these become holes in the face. */
  innerLoops: SketchLoop[];
};

export type ProfileIssueKind = "self-intersection" | "open-chain" | "degenerate";

export type ProfileIssue = {
  kind: ProfileIssueKind;
  message: string;
  entityIds: SketchEntityId[];
};

export type ProfileResult = {
  regions: SketchRegion[];
  /** Entities that belong to no closed loop, so the user can see what is open. */
  openEntityIds: SketchEntityId[];
  issues: ProfileIssue[];
};

export type DiscretizeOptions = {
  /** Maximum deviation between the chord and the true curve, in millimetres. */
  tolerance?: number;
  /** Upper bound on segments per curve, so a huge radius cannot explode. */
  maxSegments?: number;
};

const DEFAULT_TOLERANCE = 0.02;
const DEFAULT_MAX_SEGMENTS = 512;
const WELD_TOLERANCE = 1e-6;

/** Number of chords needed to approximate a circular sweep within `tolerance`. */
function arcSegmentCount(radius: number, sweep: number, tolerance: number, maxSegments: number) {
  if (radius <= tolerance) return 3;
  // Sagitta of a chord subtending angle θ is r·(1 − cos(θ/2)).
  const maxAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)));
  const count = maxAngle > 1e-9 ? Math.ceil(Math.abs(sweep) / maxAngle) : maxSegments;
  return Math.max(2, Math.min(maxSegments, count));
}

function bezierPoint(control: readonly Vec2[], t: number): Vec2 {
  // de Casteljau; works for any degree, which keeps the migrated cubic splines
  // and any future higher-degree curve on the same code path.
  let points = control.map((point) => ({ ...point }));
  while (points.length > 1) {
    const next: Vec2[] = [];
    for (let index = 0; index + 1 < points.length; index += 1) {
      next.push({
        x: points[index].x + (points[index + 1].x - points[index].x) * t,
        y: points[index].y + (points[index + 1].y - points[index].y) * t,
      });
    }
    points = next;
  }
  return points[0];
}

/** Polyline approximation of one entity, from its start point to its end point. */
export function discretizeEntity(entity: SketchEntity, options: DiscretizeOptions = {}): Vec2[] {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;

  switch (entity.type) {
    case "point":
      return [{ ...entity.p }];
    case "line":
      return [{ ...entity.a }, { ...entity.b }];
    case "circle": {
      const count = arcSegmentCount(entity.r, TWO_PI, tolerance, maxSegments);
      return Array.from({ length: count + 1 }, (_unused, index) => {
        const angle = (index / count) * TWO_PI;
        return { x: entity.c.x + entity.r * Math.cos(angle), y: entity.c.y + entity.r * Math.sin(angle) };
      });
    }
    case "arc": {
      const sweep = entity.endAngle - entity.startAngle;
      const count = arcSegmentCount(entity.r, sweep, tolerance, maxSegments);
      return Array.from({ length: count + 1 }, (_unused, index) => {
        const angle = entity.startAngle + (index / count) * sweep;
        return { x: entity.c.x + entity.r * Math.cos(angle), y: entity.c.y + entity.r * Math.sin(angle) };
      });
    }
    case "spline": {
      if (entity.ctrl.length < 2) return entity.ctrl.map((point) => ({ ...point }));
      const count = Math.min(maxSegments, Math.max(8, entity.ctrl.length * 12));
      return Array.from({ length: count + 1 }, (_unused, index) => bezierPoint(entity.ctrl, index / count));
    }
    default:
      return [];
  }
}

export function signedArea(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const straddles = a.y > point.y !== b.y > point.y;
    if (straddles && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** A circle, or an arc that sweeps a full turn, closes on its own. */
function isSelfClosing(entity: SketchEntity): boolean {
  if (entity.type === "circle") return true;
  if (entity.type === "arc") return Math.abs(entity.endAngle - entity.startAngle) >= TWO_PI - 1e-9;
  return false;
}

function entityEndpoints(entity: SketchEntity): { start: Vec2; end: Vec2 } | null {
  const points = discretizeEntity(entity, { tolerance: DEFAULT_TOLERANCE });
  if (points.length < 2) return null;
  return { start: points[0], end: points[points.length - 1] };
}

type DirectedEdge = {
  index: number;
  entityId: SketchEntityId;
  reversed: boolean;
  fromNode: number;
  toNode: number;
  /** Direction leaving `fromNode`, for the angular ordering at each node. */
  angle: number;
  points: Vec2[];
};

/**
 * Welds endpoints that coincide within tolerance into shared graph nodes.
 * Sketches have few endpoints, so the straightforward pairwise search is both
 * exact and fast enough — a spatial grid would risk splitting a pair that
 * straddles a cell boundary.
 */
function weldNodes(positions: Vec2[], tolerance: number): number[] {
  const nodeOf: number[] = [];
  const nodes: Vec2[] = [];

  positions.forEach((position) => {
    const existing = nodes.findIndex((node) => Math.hypot(node.x - position.x, node.y - position.y) <= tolerance);
    if (existing >= 0) {
      nodeOf.push(existing);
    } else {
      nodes.push(position);
      nodeOf.push(nodes.length - 1);
    }
  });

  return nodeOf;
}

function loopFromDirectedEdges(edges: DirectedEdge[]): SketchLoop {
  const points: Vec2[] = [];
  edges.forEach((edge) => {
    // Drop each segment's first point: it repeats the previous segment's last.
    edge.points.slice(0, -1).forEach((point) => points.push(point));
  });
  return {
    segments: edges.map((edge) => ({ entityId: edge.entityId, reversed: edge.reversed })),
    points,
    area: signedArea(points),
  };
}

function orientLoop(loop: SketchLoop): SketchLoop {
  if (loop.area >= 0) return loop;
  return {
    segments: [...loop.segments].reverse().map((segment) => ({ ...segment, reversed: !segment.reversed })),
    points: [...loop.points].reverse(),
    area: -loop.area,
  };
}

/**
 * Finds every closed region formed by the sketch's real (non-construction)
 * geometry, together with the holes nested directly inside each one.
 */
export function findSketchRegions(
  entities: readonly SketchEntity[],
  options: DiscretizeOptions & { weldTolerance?: number } = {},
): ProfileResult {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const weldTolerance = options.weldTolerance ?? Math.max(WELD_TOLERANCE, tolerance * 1e-3);
  const issues: ProfileIssue[] = [];

  const usable = entities.filter((entity) => !entity.construction && entity.type !== "point");
  const loops: SketchLoop[] = [];
  const usedEntityIds = new Set<SketchEntityId>();

  // Circles and full arcs are loops on their own and never join the graph.
  usable.filter(isSelfClosing).forEach((entity) => {
    const points = discretizeEntity(entity, { tolerance });
    // The sampling repeats the start point at the end; drop it for the polygon.
    const polygon = points.slice(0, -1);
    if (polygon.length < 3) {
      issues.push({ kind: "degenerate", message: "A circle is too small to form a region", entityIds: [entity.id] });
      return;
    }
    usedEntityIds.add(entity.id);
    loops.push(
      orientLoop({
        segments: [{ entityId: entity.id, reversed: false }],
        points: polygon,
        area: signedArea(polygon),
      }),
    );
  });

  const chained = usable.filter((entity) => !isSelfClosing(entity));
  const endpointPositions: Vec2[] = [];
  const endpointOwners: { entity: SketchEntity; points: Vec2[] }[] = [];

  chained.forEach((entity) => {
    const points = discretizeEntity(entity, { tolerance });
    const endpoints = entityEndpoints(entity);
    if (!endpoints || points.length < 2) {
      issues.push({ kind: "degenerate", message: "An entity has no length", entityIds: [entity.id] });
      return;
    }
    endpointOwners.push({ entity, points });
    endpointPositions.push(endpoints.start, endpoints.end);
  });

  const nodeOf = weldNodes(endpointPositions, weldTolerance);

  const directed: DirectedEdge[] = [];
  endpointOwners.forEach(({ entity, points }, ownerIndex) => {
    const startNode = nodeOf[ownerIndex * 2];
    const endNode = nodeOf[ownerIndex * 2 + 1];
    const forwardAngle = Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x);
    const backwardAngle = Math.atan2(
      points[points.length - 2].y - points[points.length - 1].y,
      points[points.length - 2].x - points[points.length - 1].x,
    );
    directed.push({
      index: directed.length,
      entityId: entity.id,
      reversed: false,
      fromNode: startNode,
      toNode: endNode,
      angle: normalizeAngle(forwardAngle),
      points,
    });
    directed.push({
      index: directed.length,
      entityId: entity.id,
      reversed: true,
      fromNode: endNode,
      toNode: startNode,
      angle: normalizeAngle(backwardAngle),
      points: [...points].reverse(),
    });
  });

  const outgoing = new Map<number, DirectedEdge[]>();
  directed.forEach((edge) => {
    const existing = outgoing.get(edge.fromNode) ?? [];
    existing.push(edge);
    outgoing.set(edge.fromNode, existing);
  });
  outgoing.forEach((edges) => edges.sort((a, b) => a.angle - b.angle));

  const twinOf = (edge: DirectedEdge) => directed[edge.reversed ? edge.index - 1 : edge.index + 1];

  // Standard planar face traversal: arriving along an edge, leave by the next
  // edge clockwise from the one you came in on. Every directed edge belongs to
  // exactly one face, and bounded faces come out counter-clockwise.
  const visited = new Set<number>();
  directed.forEach((start) => {
    if (visited.has(start.index)) return;

    const cycle: DirectedEdge[] = [];
    let current = start;
    for (let guard = 0; guard <= directed.length; guard += 1) {
      if (visited.has(current.index)) break;
      visited.add(current.index);
      cycle.push(current);

      const incomingTwin = twinOf(current);
      const candidates = outgoing.get(current.toNode) ?? [];
      if (candidates.length === 0) break;
      const position = candidates.findIndex((candidate) => candidate.index === incomingTwin.index);
      if (position < 0) break;
      const next = candidates[(position - 1 + candidates.length) % candidates.length];
      if (next.index === start.index) {
        const loop = loopFromDirectedEdges(cycle);
        // The unbounded face traverses clockwise, and a dangling chain walks out
        // and straight back for zero area. Only a bounded face is a region — and
        // only its entities count as used, so open geometry is still reported.
        if (loop.area > 1e-12) {
          loops.push(loop);
          cycle.forEach((edge) => usedEntityIds.add(edge.entityId));
        }
        return;
      }
      current = next;
    }
  });

  const openEntityIds = usable.filter((entity) => !usedEntityIds.has(entity.id)).map((entity) => entity.id);
  if (openEntityIds.length > 0) {
    issues.push({
      kind: "open-chain",
      message: "Some geometry does not close a region. Join or trim the ends to extrude it.",
      entityIds: openEntityIds,
    });
  }

  const crossing = findSketchOutlineIntersection(loops.map((loop) => loop.points));
  if (crossing) {
    issues.push({
      kind: "self-intersection",
      message: "Profile loops cross each other. Trim the crossing geometry before creating a feature.",
      entityIds: [
        ...(loops[crossing.outlineA]?.segments.map((segment) => segment.entityId) ?? []),
        ...(loops[crossing.outlineB]?.segments.map((segment) => segment.entityId) ?? []),
      ],
    });
  }

  return { regions: nestLoops(loops), openEntityIds, issues };
}

/**
 * Groups loops into regions by containment depth. Even depth is material and
 * becomes a region's outer loop; the loops directly inside it are its holes.
 * Working on depth rather than immediate containment is what makes an island
 * inside a hole come out as its own region rather than as part of the hole.
 */
export function nestLoops(loops: readonly SketchLoop[]): SketchRegion[] {
  const depths = loops.map((loop) => {
    const probe = loop.points[0];
    if (!probe) return 0;
    return loops.reduce((depth, other) => {
      if (other === loop) return depth;
      return pointInPolygon(probe, other.points) ? depth + 1 : depth;
    }, 0);
  });

  const parentOf = loops.map((loop, index) => {
    if (depths[index] === 0) return -1;
    let best = -1;
    let bestArea = Infinity;
    loops.forEach((other, otherIndex) => {
      if (otherIndex === index) return;
      if (depths[otherIndex] !== depths[index] - 1) return;
      if (!pointInPolygon(loop.points[0], other.points)) return;
      // The immediate parent is the smallest containing loop one level up.
      if (Math.abs(other.area) < bestArea) {
        bestArea = Math.abs(other.area);
        best = otherIndex;
      }
    });
    return best;
  });

  return loops
    .map((loop, index) => ({ loop, index }))
    .filter(({ index }) => depths[index] % 2 === 0)
    .map(({ loop, index }) => ({
      id: `region-${index}`,
      outerLoop: loop,
      innerLoops: loops.filter((_child, childIndex) => depths[childIndex] % 2 === 1 && parentOf[childIndex] === index),
    }));
}

/** Total enclosed area of a region, holes removed. */
export function regionArea(region: SketchRegion): number {
  return region.innerLoops.reduce((total, hole) => total - Math.abs(hole.area), Math.abs(region.outerLoop.area));
}
