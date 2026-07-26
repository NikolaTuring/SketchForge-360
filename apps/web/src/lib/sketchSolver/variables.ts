// Variable packing for the sketch solver.
//
// Every entity contributes a fixed slice of the variable vector:
//   point   2  (x, y)
//   line    4  (ax, ay, bx, by)
//   circle  3  (cx, cy, r)
//   arc     5  (cx, cy, r, startAngle, endAngle)
//   spline  2n (control points)
//
// Arc endpoints are *derived* from (centre, radius, angle) rather than stored,
// so an endpoint can never drift off its own arc no matter what the solver does.

import { add, constant, cos, mul, scale, sin, sub, variable, type Ad } from "@/lib/sketchSolver/autodiff";
import type { SketchEntity, SketchEntityId, SketchPointRef, SketchPointRole } from "@/types/sketch";

export type VariableLayout = {
  count: number;
  offsets: Map<SketchEntityId, number>;
  entities: Map<SketchEntityId, SketchEntity>;
  order: SketchEntity[];
};

export type AdPoint = { x: Ad; y: Ad };
export type AdVector = { x: Ad; y: Ad };

export function entityVariableCount(entity: SketchEntity): number {
  switch (entity.type) {
    case "point":
      return 2;
    case "line":
      return 4;
    case "circle":
      return 3;
    case "arc":
      return 5;
    case "spline":
      return entity.ctrl.length * 2;
    default:
      return 0;
  }
}

export function buildLayout(entities: readonly SketchEntity[]): VariableLayout {
  const offsets = new Map<SketchEntityId, number>();
  const byId = new Map<SketchEntityId, SketchEntity>();
  let count = 0;

  entities.forEach((entity) => {
    offsets.set(entity.id, count);
    byId.set(entity.id, entity);
    count += entityVariableCount(entity);
  });

  return { count, offsets, entities: byId, order: [...entities] };
}

export function packVariables(layout: VariableLayout): Float64Array {
  const values = new Float64Array(layout.count);
  layout.order.forEach((entity) => {
    const base = layout.offsets.get(entity.id) ?? 0;
    switch (entity.type) {
      case "point":
        values[base] = entity.p.x;
        values[base + 1] = entity.p.y;
        break;
      case "line":
        values[base] = entity.a.x;
        values[base + 1] = entity.a.y;
        values[base + 2] = entity.b.x;
        values[base + 3] = entity.b.y;
        break;
      case "circle":
        values[base] = entity.c.x;
        values[base + 1] = entity.c.y;
        values[base + 2] = entity.r;
        break;
      case "arc":
        values[base] = entity.c.x;
        values[base + 1] = entity.c.y;
        values[base + 2] = entity.r;
        values[base + 3] = entity.startAngle;
        values[base + 4] = entity.endAngle;
        break;
      case "spline":
        entity.ctrl.forEach((point, index) => {
          values[base + index * 2] = point.x;
          values[base + index * 2 + 1] = point.y;
        });
        break;
      default:
        break;
    }
  });
  return values;
}

export function unpackVariables(layout: VariableLayout, values: Float64Array): SketchEntity[] {
  return layout.order.map((entity) => {
    const base = layout.offsets.get(entity.id) ?? 0;
    switch (entity.type) {
      case "point":
        return { ...entity, p: { x: values[base], y: values[base + 1] } };
      case "line":
        return {
          ...entity,
          a: { x: values[base], y: values[base + 1] },
          b: { x: values[base + 2], y: values[base + 3] },
        };
      case "circle":
        return { ...entity, c: { x: values[base], y: values[base + 1] }, r: Math.abs(values[base + 2]) };
      case "arc":
        return {
          ...entity,
          c: { x: values[base], y: values[base + 1] },
          r: Math.abs(values[base + 2]),
          startAngle: values[base + 3],
          endAngle: values[base + 4],
        };
      case "spline":
        return {
          ...entity,
          ctrl: entity.ctrl.map((_point, index) => ({ x: values[base + index * 2], y: values[base + index * 2 + 1] })),
        };
      default:
        return entity;
    }
  });
}

function slot(layout: VariableLayout, entityId: SketchEntityId, offset: number, values: Float64Array): Ad {
  const base = layout.offsets.get(entityId);
  if (base === undefined) return constant(0);
  const index = base + offset;
  return variable(index, values[index]);
}

/**
 * The (x, y) of an entity's characteristic point, carrying its derivatives with
 * respect to the entity's variables. Returns null when the role does not exist
 * on that entity, which the residual builder reports as an invalid constraint.
 */
export function evaluatePointRef(layout: VariableLayout, values: Float64Array, ref: SketchPointRef): AdPoint | null {
  const entity = layout.entities.get(ref.entityId);
  if (!entity) return null;
  return evaluateEntityPoint(layout, values, entity, ref.role);
}

export function evaluateEntityPoint(
  layout: VariableLayout,
  values: Float64Array,
  entity: SketchEntity,
  role: SketchPointRole,
): AdPoint | null {
  const id = entity.id;
  const at = (offset: number) => slot(layout, id, offset, values);

  switch (entity.type) {
    case "point":
      return role === "point" || role === "start" || role === "end" ? { x: at(0), y: at(1) } : null;
    case "line":
      if (role === "start") return { x: at(0), y: at(1) };
      if (role === "end") return { x: at(2), y: at(3) };
      if (role === "center") return { x: scale(add(at(0), at(2)), 0.5), y: scale(add(at(1), at(3)), 0.5) };
      return null;
    case "circle":
      return role === "center" ? { x: at(0), y: at(1) } : null;
    case "arc": {
      if (role === "center") return { x: at(0), y: at(1) };
      if (role !== "start" && role !== "end") return null;
      const angle = role === "start" ? at(3) : at(4);
      const radius = at(2);
      return { x: add(at(0), mul(radius, cos(angle))), y: add(at(1), mul(radius, sin(angle))) };
    }
    case "spline": {
      if (role === "start") return { x: at(0), y: at(1) };
      if (role === "end") {
        const last = (entity.ctrl.length - 1) * 2;
        return { x: at(last), y: at(last + 1) };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Direction vector of a line entity (end − start), with derivatives. */
export function evaluateLineDirection(layout: VariableLayout, values: Float64Array, entityId: SketchEntityId): AdVector | null {
  const entity = layout.entities.get(entityId);
  if (entity?.type !== "line") return null;
  const start = evaluateEntityPoint(layout, values, entity, "start");
  const end = evaluateEntityPoint(layout, values, entity, "end");
  if (!start || !end) return null;
  return { x: sub(end.x, start.x), y: sub(end.y, start.y) };
}

/** Radius of a circle or arc, with derivatives. */
export function evaluateRadius(layout: VariableLayout, values: Float64Array, entityId: SketchEntityId): Ad | null {
  const entity = layout.entities.get(entityId);
  if (entity?.type !== "circle" && entity?.type !== "arc") return null;
  return slot(layout, entityId, 2, values);
}

/** Centre of a circle or arc, with derivatives. */
export function evaluateCenter(layout: VariableLayout, values: Float64Array, entityId: SketchEntityId): AdPoint | null {
  const entity = layout.entities.get(entityId);
  if (entity?.type !== "circle" && entity?.type !== "arc") return null;
  return { x: slot(layout, entityId, 0, values), y: slot(layout, entityId, 1, values) };
}
