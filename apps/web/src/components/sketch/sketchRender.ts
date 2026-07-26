// Drawing sketch entities as SVG.
//
// Sketch units *are* SVG units — pan and zoom happen in the `viewBox`, never in
// a transform on the geometry. That is what keeps a 25 mm line 25 units long in
// the markup, so a coordinate read off the DOM in a test means what it says, and
// stroke widths are the only thing that has to be corrected for zoom.

import { TWO_PI, arcPoint, normalizeAngle } from "@/lib/sketchEntities";
import type { SketchEntity, Vec2 } from "@/types/sketch";

/** Bezier control points that approximate a quarter circle or less. */
const KAPPA = 0.5522847498307936;

function arcSegmentPath(center: Vec2, radius: number, from: number, to: number): string {
  const sweep = to - from;
  // SVG's own arc command cannot express a full circle in one go and flips its
  // large-arc flag at 180 degrees; splitting into quarter-circle Beziers keeps
  // one code path for every sweep, including a full turn.
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const step = sweep / steps;
  const handle = (KAPPA * step) / (Math.PI / 2) * radius;

  let path = "";
  for (let index = 0; index < steps; index += 1) {
    const a0 = from + step * index;
    const a1 = a0 + step;
    const p0 = arcPoint({ c: center, r: radius }, a0);
    const p1 = arcPoint({ c: center, r: radius }, a1);
    const t0 = { x: -Math.sin(a0), y: Math.cos(a0) };
    const t1 = { x: -Math.sin(a1), y: Math.cos(a1) };
    if (index === 0) path += `M ${p0.x} ${p0.y} `;
    path += `C ${p0.x + t0.x * handle} ${p0.y + t0.y * handle} ${p1.x - t1.x * handle} ${p1.y - t1.y * handle} ${p1.x} ${p1.y} `;
  }
  return path.trim();
}

/** The `d` attribute for an entity, or an empty string for a bare point. */
export function entityPath(entity: SketchEntity): string {
  switch (entity.type) {
    case "line":
      return `M ${entity.a.x} ${entity.a.y} L ${entity.b.x} ${entity.b.y}`;
    case "circle":
      return `${arcSegmentPath(entity.c, entity.r, 0, TWO_PI)} Z`;
    case "arc":
      return arcSegmentPath(entity.c, entity.r, entity.startAngle, entity.endAngle);
    case "spline": {
      if (entity.ctrl.length < 2) return "";
      const [first, ...rest] = entity.ctrl;
      // Drawn as its control polygon: the kernel builds the real Bezier, and a
      // polygon that visibly differs is honest about that rather than showing a
      // curve the geometry does not have.
      return `M ${first.x} ${first.y} ` + rest.map((point) => `L ${point.x} ${point.y}`).join(" ");
    }
    default:
      return "";
  }
}

/** Points worth drawing a handle on, so they can be grabbed and constrained. */
export function entityHandles(entity: SketchEntity): { point: Vec2; role: "start" | "end" | "center" | "point" }[] {
  switch (entity.type) {
    case "line":
      return [{ point: entity.a, role: "start" }, { point: entity.b, role: "end" }];
    case "circle":
      return [{ point: entity.c, role: "center" }];
    case "arc":
      return [
        { point: entity.c, role: "center" },
        { point: arcPoint(entity, entity.startAngle), role: "start" },
        { point: arcPoint(entity, entity.endAngle), role: "end" },
      ];
    case "point":
      return [{ point: entity.p, role: "point" }];
    default:
      return [];
  }
}

/** A label anchor near the middle of an entity, for dimensions and glyphs. */
export function entityMidpoint(entity: SketchEntity): Vec2 {
  switch (entity.type) {
    case "line":
      return { x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 };
    case "circle":
      return { x: entity.c.x + entity.r, y: entity.c.y };
    case "arc":
      return arcPoint(entity, entity.startAngle + normalizeAngle(entity.endAngle - entity.startAngle) / 2);
    case "point":
      return entity.p;
    default:
      return entity.ctrl[Math.floor(entity.ctrl.length / 2)] ?? { x: 0, y: 0 };
  }
}

/**
 * Bounds of a set of entities, with a margin, for the initial view.
 *
 * Returns null for an empty sketch: there is nothing to frame, and inventing a
 * box would put the origin somewhere arbitrary on the first click.
 */
export function entitiesBounds(entities: readonly SketchEntity[]): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (point: Vec2) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };

  entities.forEach((entity) => {
    if (entity.type === "line") {
      include(entity.a);
      include(entity.b);
    } else if (entity.type === "circle" || entity.type === "arc") {
      // The whole circle, not just the endpoints: an arc bulges past its chord.
      include({ x: entity.c.x - entity.r, y: entity.c.y - entity.r });
      include({ x: entity.c.x + entity.r, y: entity.c.y + entity.r });
    } else if (entity.type === "point") {
      include(entity.p);
    } else {
      entity.ctrl.forEach(include);
    }
  });

  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}
