import { describe, expect, it } from "vitest";

import {
  TOOL_POINT_COUNT,
  buildToolGeometry,
  clickDrawTool,
  draftPreview,
  pruneConstraints,
  snapCandidates,
  snapPoint,
  type SketchDraft,
} from "@/lib/sketchSession";
import { createCircle, createLine, vec2 } from "@/lib/sketchEntities";
import { findSketchRegions } from "@/lib/sketchProfiles";
import type { SketchConstraint, SketchEntity } from "@/types/sketch";

/**
 * The drawing state machine.
 *
 * "What does the next click do" is the part of a sketcher people actually feel,
 * and it is far easier to get right here than by clicking. The cases that matter
 * are the awkward ones: a misclick in the same place, three collinear points, a
 * chain that has to stay joined when something is dragged.
 */

let counter = 0;
const nextId = () => {
  counter += 1;
  return `s-${counter}`;
};

describe("tool geometry", () => {
  it("builds a rectangle as four constrained lines", () => {
    const built = buildToolGeometry("rectangle", [vec2(0, 0), vec2(40, 30)], nextId);
    expect(built?.entities).toHaveLength(4);
    // The corners have to be joined and the sides axis-aligned, or the
    // rectangle falls apart the first time a corner is dragged.
    expect(built?.constraints.filter((constraint) => constraint.type === "coincident")).toHaveLength(4);
    expect(built?.constraints.some((constraint) => constraint.type === "horizontal")).toBe(true);
  });

  it("gives every entity and constraint an id from the session counter", () => {
    const built = buildToolGeometry("rectangle", [vec2(0, 0), vec2(40, 30)], nextId);
    const ids = [...(built?.entities ?? []), ...(built?.constraints ?? [])].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^s-\d+$/));
  });

  it("keeps a remapped constraint pointing at the remapped entity", () => {
    // The constructors mint their own ids and they are rewritten; a constraint
    // left naming an old id is a constraint the solver silently ignores.
    const built = buildToolGeometry("rectangle", [vec2(0, 0), vec2(40, 30)], nextId);
    const live = new Set(built?.entities.map((entity) => entity.id));
    expect(pruneConstraints(built?.constraints ?? [], built?.entities ?? [])).toHaveLength(built?.constraints.length ?? -1);
    built?.constraints.forEach((constraint) => {
      const record = constraint as unknown as Record<string, { entityId?: string } | string>;
      ["a", "b", "entity", "line"].forEach((key) => {
        const value = record[key];
        if (typeof value === "string") expect(live.has(value)).toBe(true);
        else if (value && typeof value === "object" && value.entityId) expect(live.has(value.entityId)).toBe(true);
      });
    });
  });

  it("refuses a zero-size rectangle", () => {
    expect(buildToolGeometry("rectangle", [vec2(5, 5), vec2(5, 12)], nextId)).toBeNull();
  });

  it("refuses a zero-length line", () => {
    expect(buildToolGeometry("line", [vec2(3, 3), vec2(3, 3)], nextId)).toBeNull();
  });

  it("builds a circle through three points", () => {
    const built = buildToolGeometry("circle-3p", [vec2(5, 0), vec2(0, 5), vec2(-5, 0)], nextId);
    const circle = built?.entities[0] as { c: { x: number; y: number }; r: number };
    expect(circle.c.x).toBeCloseTo(0, 9);
    expect(circle.c.y).toBeCloseTo(0, 9);
    expect(circle.r).toBeCloseTo(5, 9);
  });

  it("refuses three collinear points for a circle", () => {
    // The circumscribed circle is infinitely large; a huge one is not an answer.
    expect(buildToolGeometry("circle-3p", [vec2(0, 0), vec2(5, 0), vec2(10, 0)], nextId)).toBeNull();
  });

  it("builds a polygon with the requested number of sides", () => {
    const built = buildToolGeometry("polygon", [vec2(0, 0), vec2(10, 0)], nextId, { polygonSides: 5 });
    expect(built?.entities.filter((entity) => entity.type === "line")).toHaveLength(5);
  });

  it("clamps an absurd polygon side count instead of hanging", () => {
    const built = buildToolGeometry("polygon", [vec2(0, 0), vec2(10, 0)], nextId, { polygonSides: 5000 });
    expect(built?.entities.filter((entity) => entity.type === "line").length).toBeLessThanOrEqual(64);
  });

  it("takes a slot's width from the third click's distance to its axis", () => {
    // The third click is 4 mm off the axis, so the caps have a 4 mm radius —
    // measuring to the start point instead would give 20.4.
    const built = buildToolGeometry("slot", [vec2(0, 0), vec2(20, 0), vec2(20, 4)], nextId);
    const arcs = built?.entities.filter((entity) => entity.type === "arc") ?? [];
    expect(arcs).toHaveLength(2);
    expect((arcs[0] as { r: number }).r).toBeCloseTo(4, 9);
  });

  it("marks construction geometry when asked", () => {
    const built = buildToolGeometry("line", [vec2(0, 0), vec2(10, 0)], nextId, { construction: true });
    expect(built?.entities[0].construction).toBe(true);
  });
});

describe("clicking", () => {
  it("collects points until the tool has enough", () => {
    let draft: SketchDraft | null = null;
    const first = clickDrawTool("arc-3p", draft, vec2(0, 0), nextId);
    expect(first.geometry).toBeNull();
    draft = first.draft;

    const second = clickDrawTool("arc-3p", draft, vec2(5, 5), nextId);
    expect(second.geometry).toBeNull();
    draft = second.draft;
    expect(draft?.points).toHaveLength(2);

    const third = clickDrawTool("arc-3p", draft, vec2(10, 0), nextId);
    expect(third.geometry?.entities[0].type).toBe("arc");
    expect(third.draft).toBeNull();
  });

  it("drops only the last click when the shape is degenerate", () => {
    // A misclick should cost one click, not the whole shape.
    const started = clickDrawTool("rectangle", null, vec2(0, 0), nextId);
    const degenerate = clickDrawTool("rectangle", started.draft, vec2(0, 0), nextId);
    expect(degenerate.geometry).toBeNull();
    expect(degenerate.draft?.points).toHaveLength(1);

    const good = clickDrawTool("rectangle", degenerate.draft, vec2(10, 8), nextId);
    expect(good.geometry?.entities).toHaveLength(4);
  });

  it("chains the line tool and joins each segment to the last", () => {
    const first = clickDrawTool("line", null, vec2(0, 0), nextId);
    const second = clickDrawTool("line", first.draft, vec2(40, 0), nextId);
    expect(second.geometry?.entities).toHaveLength(1);
    // No previous segment, so no join yet.
    expect(second.geometry?.constraints).toHaveLength(0);
    expect(second.draft?.points).toEqual([vec2(40, 0)]);

    const third = clickDrawTool("line", second.draft, vec2(40, 30), nextId);
    const join = third.geometry?.constraints[0];
    expect(join?.type).toBe("coincident");
    // The join has to name the previous segment's end and this one's start.
    expect((join as { a: { entityId: string; role: string } }).a).toEqual({
      entityId: second.geometry?.entities[0].id,
      role: "end",
    });
  });

  it("draws a chain that region detection sees as a closed profile", () => {
    // The point of chaining: the coincidences it emits are what make the loop
    // close. Four corners drawn as four clicks plus a return to the start.
    const corners = [vec2(0, 0), vec2(40, 0), vec2(40, 30), vec2(0, 30), vec2(0, 0)];
    const entities: SketchEntity[] = [];
    const constraints: SketchConstraint[] = [];
    let draft: SketchDraft | null = null;

    corners.forEach((corner) => {
      const result = clickDrawTool("line", draft, corner, nextId);
      draft = result.draft;
      if (result.geometry) {
        entities.push(...result.geometry.entities);
        constraints.push(...result.geometry.constraints);
      }
    });

    expect(entities).toHaveLength(4);
    // Three joins between four segments; the closing one is inferred by the
    // region walk from the coincident coordinates.
    expect(constraints.filter((constraint) => constraint.type === "coincident")).toHaveLength(3);
    expect(findSketchRegions(entities).regions).toHaveLength(1);
  });

  it("starts fresh for a tool that cannot chain", () => {
    const first = clickDrawTool("circle", null, vec2(0, 0), nextId);
    const done = clickDrawTool("circle", first.draft, vec2(5, 0), nextId);
    expect(done.draft).toBeNull();
  });

  it("abandons a half-drawn shape when the tool changes", () => {
    const started = clickDrawTool("rectangle", null, vec2(0, 0), nextId);
    // Clicking with a different tool must not treat the rectangle's corner as
    // this tool's first point.
    const switched = clickDrawTool("circle", started.draft, vec2(20, 20), nextId);
    expect(switched.draft?.tool).toBe("circle");
    expect(switched.draft?.points).toEqual([vec2(20, 20)]);
  });
});

describe("preview", () => {
  it("shows the finished shape once the points allow it", () => {
    const preview = draftPreview({ tool: "rectangle", points: [vec2(0, 0)] }, vec2(40, 30));
    expect(preview).toHaveLength(4);
  });

  it("falls back to a rubber band when the shape is not determined yet", () => {
    const preview = draftPreview({ tool: "arc-3p", points: [vec2(0, 0)] }, vec2(10, 0));
    expect(preview).toHaveLength(1);
    expect(preview[0].type).toBe("line");
    expect(preview[0].construction).toBe(true);
  });

  it("shows nothing with no draft", () => {
    expect(draftPreview(null, vec2(0, 0))).toEqual([]);
  });
});

describe("snapping", () => {
  it("rounds to the grid step", () => {
    expect(snapPoint(vec2(4.4, -2.6), 1)).toEqual({ x: 4, y: -3 });
    expect(snapPoint(vec2(4.4, -2.6), 0.5)).toEqual({ x: 4.5, y: -2.5 });
  });

  it("leaves a point alone when snapping is off", () => {
    expect(snapPoint(vec2(4.4, -2.6), 0)).toEqual({ x: 4.4, y: -2.6 });
  });

  it("offers endpoints, midpoints and centres, nearest first", () => {
    const entities: SketchEntity[] = [
      { ...createLine(vec2(0, 0), vec2(10, 0)), id: "l" },
      { ...createCircle(vec2(20, 0), 3), id: "c" },
    ];
    const near = snapCandidates(entities, vec2(9.6, 0.2), 1);
    expect(near[0].point).toEqual({ x: 10, y: 0 });
    expect(near[0].kind).toBe("endpoint");

    const middle = snapCandidates(entities, vec2(5.1, 0), 1);
    expect(middle[0].kind).toBe("midpoint");

    const centre = snapCandidates(entities, vec2(20.2, 0), 1);
    expect(centre[0].kind).toBe("center");
  });

  it("offers nothing outside the snap radius", () => {
    const entities: SketchEntity[] = [{ ...createLine(vec2(0, 0), vec2(10, 0)), id: "l" }];
    expect(snapCandidates(entities, vec2(50, 50), 1)).toEqual([]);
  });
});

describe("pruning", () => {
  it("drops a constraint whose entity is gone", () => {
    const entities: SketchEntity[] = [{ ...createLine(vec2(0, 0), vec2(10, 0)), id: "kept" }];
    const constraints: SketchConstraint[] = [
      { id: "c1", type: "horizontal", entity: "kept" },
      { id: "c2", type: "horizontal", entity: "deleted" },
      { id: "c3", type: "parallel", a: "kept", b: "deleted" },
    ];
    // A constraint naming a deleted entity is not merely useless: the solver
    // would treat it as a reference to nothing and its rank accounting would
    // be wrong, which shows up as a phantom degree of freedom.
    expect(pruneConstraints(constraints, entities).map((constraint) => constraint.id)).toEqual(["c1"]);
  });
});

describe("tool table", () => {
  it("names a click count for every drawing tool", () => {
    Object.entries(TOOL_POINT_COUNT).forEach(([, count]) => {
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(3);
    });
  });
});
