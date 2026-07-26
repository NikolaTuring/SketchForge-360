// Builds exact B-Rep solids from solved sketch regions.
//
// Every loop segment still carries its analytic entity, so a circular hole comes
// out as a real cylindrical face rather than a many-sided prism — which is what
// makes the result filletable, measurable and exportable to STEP.
//
// The kernel is taken as a parameter rather than imported, so this module runs
// unchanged inside the worker and inside the Node end-to-end tests against the
// real OpenCascade build.

import { frameNormal, sketchPointToWorld } from "@/lib/sketchEntities";
import type { SketchLoop, SketchRegion } from "@/lib/sketchProfiles";
import type { SketchEntity, SketchEntityId, SketchFrame, Vec3 } from "@/types/sketch";
import type { OcctKernel, ShapeHandle } from "occt-wasm";

/** The subset of the kernel these builders touch. */
export type SketchFeatureKernel = Pick<
  OcctKernel,
  | "makeLineEdge"
  | "makeArcEdge"
  | "makeCircleEdge"
  | "makeBezierEdge"
  | "makeWire"
  | "makeFace"
  | "addHolesInFace"
  | "extrude"
  | "draftPrism"
  | "revolve"
  | "fuseAll"
  | "cutAll"
  | "common"
  | "makeCompound"
  | "fixShape"
  | "unifySameDomain"
  | "isSolid"
  | "isValid"
  | "getVolume"
  | "release"
>;

export type SketchFeatureOperation = "new" | "join" | "cut" | "intersect";
export type ExtrudeDirectionMode = "one-sided" | "symmetric" | "two-sided";

export type ExtrudeRequest = {
  distance: number;
  /** Distance on the far side; only used by the two-sided mode. */
  secondDistance?: number;
  mode?: ExtrudeDirectionMode;
  /** Draft angle in degrees. Zero produces a straight prism. */
  taperAngle?: number;
  /** Extrude against the plane normal instead of along it. */
  flip?: boolean;
};

export type RevolveRequest = {
  /** Axis in sketch coordinates: a point and a direction on the sketch plane. */
  axisPoint: { x: number; y: number };
  axisDirection: { x: number; y: number };
  /** Sweep in degrees; 360 makes a full revolution. */
  angle: number;
  flip?: boolean;
};

export class SketchFeatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SketchFeatureError";
  }
}

/**
 * Tracks every intermediate handle so a feature cannot leak kernel arena
 * entries, including on the failure paths.
 */
class HandleScope {
  private readonly handles: ShapeHandle[] = [];

  constructor(private readonly kernel: SketchFeatureKernel) {}

  keep<T extends ShapeHandle>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }

  /** Removes a handle from the scope so it survives `releaseAll`. */
  detach(handle: ShapeHandle) {
    const index = this.handles.indexOf(handle);
    if (index >= 0) this.handles.splice(index, 1);
    return handle;
  }

  releaseAll() {
    this.handles.splice(0).forEach((handle) => {
      try {
        this.kernel.release(handle);
      } catch {
        // A failed boolean can invalidate handles it consumed; nothing to do.
      }
    });
  }
}

function toOcct(point: Vec3) {
  return { x: point.x, y: point.y, z: point.z };
}

/**
 * One analytic kernel edge per sketch entity.
 *
 * Arcs go through `makeArcEdge` (start, mid, end) rather than
 * `makeCircleArc` (centre, normal, angles): the three-point form is fully
 * determined by geometry, while an angle-based form depends on whichever
 * reference direction the kernel picks for the circle's axis placement, which is
 * not the sketch frame's X axis.
 */
function buildEntityEdge(
  kernel: SketchFeatureKernel,
  scope: HandleScope,
  frame: SketchFrame,
  entity: SketchEntity,
): ShapeHandle {
  const toWorld = (x: number, y: number) => toOcct(sketchPointToWorld(frame, { x, y }));

  switch (entity.type) {
    case "line":
      return scope.keep(kernel.makeLineEdge(toWorld(entity.a.x, entity.a.y), toWorld(entity.b.x, entity.b.y)));

    case "circle":
      return scope.keep(kernel.makeCircleEdge(toWorld(entity.c.x, entity.c.y), toOcct(frameNormal(frame)), entity.r));

    case "arc": {
      const at = (angle: number) => toWorld(entity.c.x + entity.r * Math.cos(angle), entity.c.y + entity.r * Math.sin(angle));
      const middle = (entity.startAngle + entity.endAngle) / 2;
      return scope.keep(kernel.makeArcEdge(at(entity.startAngle), at(middle), at(entity.endAngle)));
    }

    case "spline": {
      if (entity.ctrl.length < 2) throw new SketchFeatureError("A spline needs at least two control points");
      return scope.keep(kernel.makeBezierEdge(entity.ctrl.map((point) => toWorld(point.x, point.y))));
    }

    default:
      throw new SketchFeatureError(`Cannot build an edge from a ${entity.type}`);
  }
}

export function buildLoopWire(
  kernel: SketchFeatureKernel,
  scope: HandleScope,
  frame: SketchFrame,
  loop: SketchLoop,
  entitiesById: ReadonlyMap<SketchEntityId, SketchEntity>,
): ShapeHandle {
  const edges = loop.segments.map((segment) => {
    const entity = entitiesById.get(segment.entityId);
    if (!entity) throw new SketchFeatureError(`Profile references a missing entity (${segment.entityId})`);
    return buildEntityEdge(kernel, scope, frame, entity);
  });

  if (edges.length === 0) throw new SketchFeatureError("A profile loop has no edges");
  // The kernel orders and orients the edges itself from their shared vertices,
  // so the loop's own traversal direction does not need to be replayed here.
  return scope.keep(kernel.makeWire(edges));
}

/** A planar face for one region, with its inner loops cut out as holes. */
export function buildRegionFace(
  kernel: SketchFeatureKernel,
  scope: HandleScope,
  frame: SketchFrame,
  region: SketchRegion,
  entitiesById: ReadonlyMap<SketchEntityId, SketchEntity>,
): ShapeHandle {
  const outerWire = buildLoopWire(kernel, scope, frame, region.outerLoop, entitiesById);
  const face = scope.keep(kernel.makeFace(outerWire));
  if (region.innerLoops.length === 0) return face;

  const holeWires = region.innerLoops.map((loop) => buildLoopWire(kernel, scope, frame, loop, entitiesById));
  return scope.keep(kernel.addHolesInFace(face, holeWires));
}

function scaledNormal(frame: SketchFrame, distance: number, flip: boolean) {
  const normal = frameNormal(frame);
  const sign = flip ? -1 : 1;
  return { x: normal.x * distance * sign, y: normal.y * distance * sign, z: normal.z * distance * sign };
}

function prism(
  kernel: SketchFeatureKernel,
  scope: HandleScope,
  face: ShapeHandle,
  offset: { x: number; y: number; z: number },
  taperAngle: number,
): ShapeHandle {
  if (Math.abs(offset.x) + Math.abs(offset.y) + Math.abs(offset.z) < 1e-12) {
    throw new SketchFeatureError("Extrude distance must be greater than zero");
  }
  return scope.keep(
    Math.abs(taperAngle) < 1e-9
      ? kernel.extrude(face, offset.x, offset.y, offset.z)
      : kernel.draftPrism(face, offset.x, offset.y, offset.z, taperAngle),
  );
}

function healSolid(kernel: SketchFeatureKernel, scope: HandleScope, shape: ShapeHandle): ShapeHandle {
  let result = shape;
  try {
    result = scope.keep(kernel.fixShape(result));
    result = scope.keep(kernel.unifySameDomain(result));
  } catch {
    // Healing is best effort; validity is checked by the caller either way.
  }
  return result;
}

export type SketchFeatureResult = {
  /** Caller-owned handle. Release it when the feature output is no longer needed. */
  shape: ShapeHandle;
  volume: number;
};

/**
 * Extrudes one or more sketch regions into a solid.
 *
 * Regions are fused rather than kept separate so that touching profiles produce
 * one clean body, which is what a user drawing two adjoining rectangles expects.
 */
export function extrudeRegions(
  kernel: SketchFeatureKernel,
  frame: SketchFrame,
  regions: readonly SketchRegion[],
  entities: readonly SketchEntity[],
  request: ExtrudeRequest,
): SketchFeatureResult {
  if (regions.length === 0) throw new SketchFeatureError("Select at least one closed profile to extrude");
  if (!Number.isFinite(request.distance) || Math.abs(request.distance) < 1e-9) {
    throw new SketchFeatureError("Extrude distance must be greater than zero");
  }

  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const scope = new HandleScope(kernel);
  const mode = request.mode ?? "one-sided";
  const taper = request.taperAngle ?? 0;

  try {
    const solids = regions.flatMap((region) => {
      const face = buildRegionFace(kernel, scope, frame, region, entitiesById);

      if (mode === "one-sided") {
        return [prism(kernel, scope, face, scaledNormal(frame, request.distance, request.flip ?? false), taper)];
      }

      // Symmetric and two-sided both grow the prism away from the sketch plane
      // in each direction, then fuse. Building them as two prisms keeps the
      // sketch plane exactly in the middle without needing a pre-translation.
      const forward = mode === "symmetric" ? request.distance / 2 : request.distance;
      const backward = mode === "symmetric" ? request.distance / 2 : (request.secondDistance ?? request.distance);
      const parts: ShapeHandle[] = [];
      if (Math.abs(forward) > 1e-9) parts.push(prism(kernel, scope, face, scaledNormal(frame, forward, request.flip ?? false), taper));
      if (Math.abs(backward) > 1e-9) parts.push(prism(kernel, scope, face, scaledNormal(frame, backward, !(request.flip ?? false)), taper));
      return parts;
    });

    if (solids.length === 0) throw new SketchFeatureError("The extrude produced no geometry");
    const fused = solids.length === 1 ? solids[0] : scope.keep(kernel.fuseAll(solids));
    const healed = healSolid(kernel, scope, fused);

    if (!kernel.isValid(healed)) throw new SketchFeatureError("The extruded body has invalid topology");
    const volume = kernel.getVolume(healed);
    if (!Number.isFinite(volume) || Math.abs(volume) < 1e-12) {
      throw new SketchFeatureError("The extrude produced an empty body");
    }

    scope.detach(healed);
    return { shape: healed, volume: Math.abs(volume) };
  } finally {
    scope.releaseAll();
  }
}

/**
 * Revolves sketch regions about an axis that lies in the sketch plane.
 *
 * A profile that touches the axis is fine; a profile that straddles it is not,
 * and the kernel reports that as invalid topology rather than producing a
 * self-intersecting body.
 */
export function revolveRegions(
  kernel: SketchFeatureKernel,
  frame: SketchFrame,
  regions: readonly SketchRegion[],
  entities: readonly SketchEntity[],
  request: RevolveRequest,
): SketchFeatureResult {
  if (regions.length === 0) throw new SketchFeatureError("Select at least one closed profile to revolve");

  const directionLength = Math.hypot(request.axisDirection.x, request.axisDirection.y);
  if (directionLength < 1e-9) throw new SketchFeatureError("The revolve axis has no direction");
  if (!Number.isFinite(request.angle) || Math.abs(request.angle) < 1e-9) {
    throw new SketchFeatureError("Revolve angle must be greater than zero");
  }

  const entitiesById = new Map(entities.map((entity) => [entity.id, entity]));
  const scope = new HandleScope(kernel);

  // The axis is given in sketch coordinates; map both the point and a point one
  // unit along it into world space to get the world-space direction.
  const axisOrigin = sketchPointToWorld(frame, request.axisPoint);
  const axisTip = sketchPointToWorld(frame, {
    x: request.axisPoint.x + request.axisDirection.x / directionLength,
    y: request.axisPoint.y + request.axisDirection.y / directionLength,
  });
  const sign = request.flip ? -1 : 1;
  const axis = {
    point: toOcct(axisOrigin),
    direction: {
      x: (axisTip.x - axisOrigin.x) * sign,
      y: (axisTip.y - axisOrigin.y) * sign,
      z: (axisTip.z - axisOrigin.z) * sign,
    },
  };

  try {
    const solids = regions.map((region) => {
      const face = buildRegionFace(kernel, scope, frame, region, entitiesById);
      return scope.keep(kernel.revolve(face, axis, (Math.abs(request.angle) * Math.PI) / 180));
    });

    const fused = solids.length === 1 ? solids[0] : scope.keep(kernel.fuseAll(solids));
    const healed = healSolid(kernel, scope, fused);

    if (!kernel.isValid(healed)) throw new SketchFeatureError("The revolved body has invalid topology");
    const volume = kernel.getVolume(healed);
    if (!Number.isFinite(volume) || Math.abs(volume) < 1e-12) {
      throw new SketchFeatureError("The revolve produced an empty body. Check that the profile does not cross the axis.");
    }

    scope.detach(healed);
    return { shape: healed, volume: Math.abs(volume) };
  } finally {
    scope.releaseAll();
  }
}

/**
 * Combines a freshly built feature body with the bodies already in the scene.
 *
 * The returned handle is caller-owned; `tool` and `targets` are consumed by the
 * kernel's boolean operations and must not be reused afterwards.
 */
export function applyFeatureOperation(
  kernel: SketchFeatureKernel,
  operation: SketchFeatureOperation,
  tool: ShapeHandle,
  targets: readonly ShapeHandle[],
): ShapeHandle {
  if (operation === "new" || targets.length === 0) return tool;

  switch (operation) {
    case "join":
      return kernel.fuseAll([...targets, tool]);
    case "cut":
      return targets.length === 1 ? kernel.cutAll(targets[0], [tool]) : kernel.cutAll(kernel.fuseAll([...targets]), [tool]);
    case "intersect": {
      const merged = targets.length === 1 ? targets[0] : kernel.fuseAll([...targets]);
      return kernel.common(merged, tool);
    }
    default:
      return tool;
  }
}

/** Exported for tests that need to drive the builders with their own scope. */
export function createHandleScope(kernel: SketchFeatureKernel) {
  return new HandleScope(kernel);
}
