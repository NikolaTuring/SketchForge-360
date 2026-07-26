import { describe, expect, it } from "vitest";

import {
  circularPattern,
  distanceToEntity,
  extendEntity,
  filletLines,
  intersectEntities,
  mirrorEntities,
  mirrorPoint,
  offsetEntities,
  rectangularPattern,
  splitEntity,
  trimEntity,
} from "@/lib/sketchEditing";
import { TWO_PI, arcPoint, createArc, createCircle, createLine, vec2 } from "@/lib/sketchEntities";
import type { SketchArcEntity, SketchEntity, SketchLineEntity } from "@/types/sketch";

/**
 * The editing maths.
 *
 * This is the part of the sketcher that fails silently: a trim that leaves a
 * micron-long stub, a mirrored arc that bulges the wrong way, an offset circle
 * with a negative radius. None of those look wrong on screen; they all reappear
 * later as a profile the kernel refuses to build.
 */

let counter = 0;
const nextId = () => {
  counter += 1;
  return `edit-${counter}`;
};

function line(ax: number, ay: number, bx: number, by: number, id = nextId()): SketchLineEntity {
  return { ...createLine(vec2(ax, ay), vec2(bx, by)), id };
}

function byId(entities: readonly SketchEntity[], id: string) {
  const found = entities.find((entity) => entity.id === id);
  if (!found) throw new Error(`no entity ${id}`);
  return found;
}

describe("intersections", () => {
  it("crosses two lines", () => {
    const hits = intersectEntities(line(0, 0, 10, 0, "a"), line(5, -5, 5, 5, "b"));
    expect(hits).toHaveLength(1);
    expect(hits[0].point.x).toBeCloseTo(5, 12);
    expect(hits[0].point.y).toBeCloseTo(0, 12);
    expect(hits[0].tA).toBeCloseTo(0.5, 12);
  });

  it("reports nothing for parallel lines", () => {
    expect(intersectEntities(line(0, 0, 10, 0, "a"), line(0, 3, 10, 3, "b"))).toEqual([]);
  });

  it("reports nothing for collinear lines", () => {
    // Overlapping collinear segments meet at infinitely many points; there is
    // no single crossing to hand back, and pretending otherwise would let a
    // trim cut at an arbitrary spot.
    expect(intersectEntities(line(0, 0, 10, 0, "a"), line(4, 0, 20, 0, "b"))).toEqual([]);
  });

  it("does not report a crossing outside either segment", () => {
    expect(intersectEntities(line(0, 0, 1, 0, "a"), line(5, -5, 5, 5, "b"))).toEqual([]);
  });

  it("cuts a circle with a secant line twice", () => {
    const hits = intersectEntities(line(-10, 0, 10, 0, "a"), { ...createCircle(vec2(0, 0), 5), id: "c" });
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => Math.round(hit.point.x)).sort((l, r) => l - r)).toEqual([-5, 5]);
  });

  it("touches a tangent line once, not twice", () => {
    // A tangent has a double root. Reporting it twice would make a trim cut a
    // zero-length piece out of the line.
    const hits = intersectEntities(line(-10, 5, 10, 5, "a"), { ...createCircle(vec2(0, 0), 5), id: "c" });
    expect(hits).toHaveLength(1);
    expect(hits[0].point.y).toBeCloseTo(5, 9);
  });

  it("misses a circle the line does not reach", () => {
    expect(intersectEntities(line(-10, 9, 10, 9, "a"), { ...createCircle(vec2(0, 0), 5), id: "c" })).toEqual([]);
  });

  it("crosses two circles twice", () => {
    const hits = intersectEntities(
      { ...createCircle(vec2(0, 0), 5), id: "a" },
      { ...createCircle(vec2(6, 0), 5), id: "b" },
    );
    expect(hits).toHaveLength(2);
    hits.forEach((hit) => expect(Math.hypot(hit.point.x, hit.point.y)).toBeCloseTo(5, 9));
  });

  it("reports nothing for concentric circles", () => {
    expect(intersectEntities({ ...createCircle(vec2(0, 0), 5), id: "a" }, { ...createCircle(vec2(0, 0), 3), id: "b" })).toEqual([]);
  });

  it("ignores a crossing that lies outside an arc's sweep", () => {
    // The upper half of a circle, and a line through the lower half. The full
    // circles cross; the arc and the line do not.
    const arc: SketchArcEntity = { ...createArc(vec2(0, 0), 5, 0, Math.PI), id: "arc" };
    expect(intersectEntities(arc, line(-10, -3, 10, -3, "l"))).toEqual([]);

    // The same line moved into the sweep does cross it.
    expect(intersectEntities(arc, line(-10, 3, 10, 3, "l2"))).toHaveLength(2);
  });
});

describe("splitting", () => {
  it("splits a line and keeps the original id on the first piece", () => {
    const pieces = splitEntity(line(0, 0, 10, 0, "l"), [0.4], nextId);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].id).toBe("l");
    expect((pieces[0] as SketchLineEntity).b.x).toBeCloseTo(4, 12);
    expect((pieces[1] as SketchLineEntity).a.x).toBeCloseTo(4, 12);
  });

  it("ignores a cut at an endpoint", () => {
    expect(splitEntity(line(0, 0, 10, 0, "l"), [0, 1], nextId)).toHaveLength(1);
  });

  it("refuses to split a circle at one point", () => {
    // One cut cannot open a closed curve.
    const pieces = splitEntity({ ...createCircle(vec2(0, 0), 5), id: "c" }, [0], nextId);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].type).toBe("circle");
  });

  it("splits a circle at two points into two arcs that cover it", () => {
    const pieces = splitEntity({ ...createCircle(vec2(0, 0), 5), id: "c" }, [0, Math.PI], nextId);
    expect(pieces).toHaveLength(2);
    const sweep = pieces
      .map((piece) => (piece as SketchArcEntity).endAngle - (piece as SketchArcEntity).startAngle)
      .reduce((total, part) => total + part, 0);
    expect(sweep).toBeCloseTo(TWO_PI, 9);
  });

  it("splits an arc within its own sweep only", () => {
    const arc: SketchArcEntity = { ...createArc(vec2(0, 0), 5, 0, Math.PI), id: "a" };
    // 3π/2 is outside the sweep and must not cut.
    expect(splitEntity(arc, [(3 * Math.PI) / 2], nextId)).toHaveLength(1);
    expect(splitEntity(arc, [Math.PI / 2], nextId)).toHaveLength(2);
  });
});

describe("trim", () => {
  it("removes the piece under the cursor", () => {
    const entities = [line(0, 0, 10, 0, "target"), line(4, -5, 4, 5, "knife")];
    const result = trimEntity(entities, "target", vec2(8, 0), nextId);

    // Pointing at the right-hand side removes it; the left survives, keeping
    // the original id so its constraints do too.
    const kept = result.entities.filter((entity) => entity.type === "line" && entity.id !== "knife");
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("target");
    expect((kept[0] as SketchLineEntity).b.x).toBeCloseTo(4, 12);
    expect(result.removedIds).toEqual([]);
  });

  it("removes the other piece when the cursor is on the other side", () => {
    const entities = [line(0, 0, 10, 0, "target"), line(4, -5, 4, 5, "knife")];
    const result = trimEntity(entities, "target", vec2(1, 0), nextId);
    const kept = result.entities.find((entity) => entity.id !== "knife");
    expect((kept as SketchLineEntity).a.x).toBeCloseTo(4, 12);
    expect((kept as SketchLineEntity).b.x).toBeCloseTo(10, 12);
  });

  it("removes a middle piece between two crossings", () => {
    const entities = [line(0, 0, 10, 0, "target"), line(3, -5, 3, 5, "k1"), line(7, -5, 7, 5, "k2")];
    const result = trimEntity(entities, "target", vec2(5, 0), nextId);
    const kept = result.entities.filter((entity) => entity.id !== "k1" && entity.id !== "k2");
    expect(kept).toHaveLength(2);
    const spans = kept.map((entity) => [(entity as SketchLineEntity).a.x, (entity as SketchLineEntity).b.x]);
    expect(spans).toContainEqual([0, 3]);
    expect(spans.some(([from, to]) => Math.abs(from - 7) < 1e-9 && Math.abs(to - 10) < 1e-9)).toBe(true);
  });

  it("deletes an entity nothing crosses", () => {
    const entities = [line(0, 0, 10, 0, "lonely")];
    const result = trimEntity(entities, "lonely", vec2(5, 0), nextId);
    expect(result.entities).toEqual([]);
    expect(result.removedIds).toEqual(["lonely"]);
  });

  it("opens a circle cut by a chord", () => {
    const entities: SketchEntity[] = [
      { ...createCircle(vec2(0, 0), 5), id: "c" },
      line(-10, 0, 10, 0, "chord"),
    ];
    const result = trimEntity(entities, "c", vec2(0, -5), nextId);
    const arcs = result.entities.filter((entity) => entity.type === "arc");
    // Both halves become arcs; the lower one, pointed at, is gone.
    expect(arcs).toHaveLength(1);
    const kept = arcs[0] as SketchArcEntity;
    expect(arcPoint(kept, (kept.startAngle + kept.endAngle) / 2).y).toBeGreaterThan(0);
  });
});

describe("extend", () => {
  it("lengthens a line to the first thing in its way", () => {
    const entities = [line(0, 0, 5, 0, "target"), line(8, -5, 8, 5, "wall"), line(12, -5, 12, 5, "far")];
    const result = extendEntity(entities, "target", vec2(4.9, 0), nextId);
    // The nearer wall wins: going past it would need the user to say how far.
    expect((byId(result.entities, "target") as SketchLineEntity).b.x).toBeCloseTo(8, 9);
  });

  it("lengthens from the end the cursor is nearest", () => {
    const entities = [line(5, 0, 10, 0, "target"), line(1, -5, 1, 5, "wall")];
    const result = extendEntity(entities, "target", vec2(5.1, 0), nextId);
    expect((byId(result.entities, "target") as SketchLineEntity).a.x).toBeCloseTo(1, 9);
  });

  it("leaves a line with nothing to reach alone", () => {
    const entities = [line(0, 0, 5, 0, "target"), line(0, 8, 5, 8, "parallel")];
    const result = extendEntity(entities, "target", vec2(5, 0), nextId);
    expect((byId(result.entities, "target") as SketchLineEntity).b.x).toBeCloseTo(5, 12);
  });

  it("grows an arc around its own circle", () => {
    const entities: SketchEntity[] = [
      { ...createArc(vec2(0, 0), 5, 0, Math.PI / 2), id: "arc" },
      line(-10, 3, 10, 3, "wall"),
    ];
    // The wall crosses the full circle in the second quadrant, past the arc's end.
    const result = extendEntity(entities, "arc", vec2(0, 5), nextId);
    const grown = byId(result.entities, "arc") as SketchArcEntity;
    expect(grown.endAngle).toBeGreaterThan(Math.PI / 2);
    expect(grown.startAngle).toBeCloseTo(0, 12);
  });
});

describe("offset", () => {
  it("moves a line sideways by the distance", () => {
    const [offset] = offsetEntities([line(0, 0, 10, 0, "l")], 2, nextId);
    expect((offset as SketchLineEntity).a.y).toBeCloseTo(2, 12);
    expect((offset as SketchLineEntity).b.y).toBeCloseTo(2, 12);
  });

  it("offsets to the other side for a negative distance", () => {
    const [offset] = offsetEntities([line(0, 0, 10, 0, "l")], -2, nextId);
    expect((offset as SketchLineEntity).a.y).toBeCloseTo(-2, 12);
  });

  it("grows and shrinks a circle", () => {
    expect((offsetEntities([{ ...createCircle(vec2(0, 0), 5), id: "c" }], 2, nextId)[0] as { r: number }).r).toBeCloseTo(7, 12);
    expect((offsetEntities([{ ...createCircle(vec2(0, 0), 5), id: "c" }], -2, nextId)[0] as { r: number }).r).toBeCloseTo(3, 12);
  });

  it("drops a circle offset past its own centre", () => {
    // A negative radius is not geometry; producing one would hand the kernel a
    // shape it cannot build.
    expect(offsetEntities([{ ...createCircle(vec2(0, 0), 5), id: "c" }], -6, nextId)).toEqual([]);
  });

  it("gives every copy a fresh id", () => {
    const source = [line(0, 0, 10, 0, "l"), { ...createCircle(vec2(0, 0), 5), id: "c" }];
    const offset = offsetEntities(source, 1, nextId);
    expect(offset.map((entity) => entity.id)).not.toContain("l");
    expect(new Set(offset.map((entity) => entity.id)).size).toBe(2);
  });
});

describe("mirror", () => {
  it("reflects a point across an axis", () => {
    expect(mirrorPoint(vec2(3, 4), vec2(0, 0), vec2(1, 0))).toEqual({ x: 3, y: -4 });
  });

  it("reflects a line", () => {
    const [mirrored] = mirrorEntities([line(1, 2, 5, 6, "l")], vec2(0, 0), vec2(1, 0), nextId);
    expect((mirrored as SketchLineEntity).a).toEqual({ x: 1, y: -2 });
    expect((mirrored as SketchLineEntity).b).toEqual({ x: 5, y: -6 });
  });

  it("keeps a mirrored arc bulging the same way relative to its chord", () => {
    // Upper half of a circle centred on the origin: its midpoint is above the
    // chord. Mirrored across the x axis, the midpoint must be below it. A
    // reflection that only negated the angles would put the arc on the wrong
    // side and turn a slot into an hourglass.
    const arc: SketchArcEntity = { ...createArc(vec2(0, 4), 5, 0, Math.PI), id: "a" };
    const [mirrored] = mirrorEntities([arc], vec2(0, 0), vec2(1, 0), nextId) as SketchArcEntity[];

    expect(mirrored.c).toEqual({ x: 0, y: -4 });
    const start = arcPoint(mirrored, mirrored.startAngle);
    const end = arcPoint(mirrored, mirrored.endAngle);
    const middle = arcPoint(mirrored, (mirrored.startAngle + mirrored.endAngle) / 2);
    expect(middle.y).toBeLessThan((start.y + end.y) / 2);
  });

  it("reflects a circle's centre and keeps its radius", () => {
    const [mirrored] = mirrorEntities([{ ...createCircle(vec2(3, 4), 2), id: "c" }], vec2(0, 0), vec2(0, 1), nextId);
    expect((mirrored as { c: { x: number } }).c.x).toBeCloseTo(-3, 12);
    expect((mirrored as { r: number }).r).toBeCloseTo(2, 12);
  });
});

describe("patterns", () => {
  it("repeats along one axis without duplicating the original", () => {
    const copies = rectangularPattern([line(0, 0, 1, 0, "l")], { step: vec2(5, 0), count: 3 }, nextId);
    // Three items in the pattern means two new ones.
    expect(copies).toHaveLength(2);
    expect((copies[0] as SketchLineEntity).a.x).toBeCloseTo(5, 12);
    expect((copies[1] as SketchLineEntity).a.x).toBeCloseTo(10, 12);
  });

  it("repeats on a grid", () => {
    const copies = rectangularPattern(
      [{ ...createCircle(vec2(0, 0), 1), id: "c" }],
      { step: vec2(5, 0), count: 3, step2: vec2(0, 4), count2: 2 },
      nextId,
    );
    expect(copies).toHaveLength(5);
  });

  it("spaces a full turn so the last copy does not land on the first", () => {
    const copies = circularPattern([{ ...createCircle(vec2(10, 0), 1), id: "c" }], { center: vec2(0, 0), count: 4 }, nextId);
    expect(copies).toHaveLength(3);
    const angles = copies.map((copy) => Math.atan2((copy as { c: { y: number } }).c.y, (copy as { c: { x: number } }).c.x));
    expect(angles[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(Math.abs(angles[1])).toBeCloseTo(Math.PI, 9);
  });

  it("puts the last copy on the far end of a partial sweep", () => {
    // 90° with three items means copies at 45° and 90°, not at 30° and 60°.
    const copies = circularPattern(
      [{ ...createCircle(vec2(10, 0), 1), id: "c" }],
      { center: vec2(0, 0), count: 3, totalAngle: Math.PI / 2 },
      nextId,
    );
    const angles = copies.map((copy) => Math.atan2((copy as { c: { y: number } }).c.y, (copy as { c: { x: number } }).c.x));
    expect(angles[0]).toBeCloseTo(Math.PI / 4, 9);
    expect(angles[1]).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe("fillet", () => {
  it("rounds a right-angle corner and shortens both legs", () => {
    const entities = [line(0, 0, 10, 0, "h"), line(0, 0, 0, 10, "v")];
    const result = filletLines(entities, "h", "v", 2, nextId);

    expect(result.arcId).not.toBeNull();
    const arc = byId(result.entities, result.arcId as string) as SketchArcEntity;
    expect(arc.r).toBeCloseTo(2, 9);
    // On a right angle the setback equals the radius.
    expect(arc.c.x).toBeCloseTo(2, 9);
    expect(arc.c.y).toBeCloseTo(2, 9);

    // Both legs now end at the tangent points, so the chain is closed.
    const horizontal = byId(result.entities, "h") as SketchLineEntity;
    const vertical = byId(result.entities, "v") as SketchLineEntity;
    expect(Math.min(horizontal.a.x, horizontal.b.x)).toBeCloseTo(2, 9);
    expect(Math.min(vertical.a.y, vertical.b.y)).toBeCloseTo(2, 9);
  });

  it("meets both legs tangentially", () => {
    const entities = [line(0, 0, 10, 0, "h"), line(0, 0, 8, 8, "d")];
    const result = filletLines(entities, "h", "d", 1.5, nextId);
    const arc = byId(result.entities, result.arcId as string) as SketchArcEntity;

    // The arc's endpoints must sit exactly on the shortened legs, or the
    // profile has a gap the kernel will reject.
    const start = arcPoint(arc, arc.startAngle);
    const end = arcPoint(arc, arc.endAngle);
    const nearest = (point: { x: number; y: number }) =>
      Math.min(distanceToEntity(byId(result.entities, "h"), point), distanceToEntity(byId(result.entities, "d"), point));
    expect(nearest(start)).toBeLessThan(1e-9);
    expect(nearest(end)).toBeLessThan(1e-9);
  });

  it("refuses a radius that does not fit rather than shrinking it", () => {
    // A 20 mm radius cannot be rounded into a 10 mm leg. Quietly using a
    // smaller one produces a part that is wrong in a way nobody checks.
    const entities = [line(0, 0, 10, 0, "h"), line(0, 0, 0, 10, "v")];
    const result = filletLines(entities, "h", "v", 20, nextId);
    expect(result.arcId).toBeNull();
    expect(result.entities).toHaveLength(2);
  });

  it("refuses parallel lines", () => {
    const entities = [line(0, 0, 10, 0, "a"), line(0, 5, 10, 5, "b")];
    expect(filletLines(entities, "a", "b", 1, nextId).arcId).toBeNull();
  });
});

describe("distance to entity", () => {
  it("clamps to a line's own extent", () => {
    // Beyond the end, the nearest point is the endpoint — not the foot of the
    // perpendicular, which is what picking the wrong formula would give.
    expect(distanceToEntity(line(0, 0, 10, 0, "l"), vec2(14, 0))).toBeCloseTo(4, 12);
    expect(distanceToEntity(line(0, 0, 10, 0, "l"), vec2(5, 3))).toBeCloseTo(3, 12);
  });

  it("measures to an arc's endpoint outside its sweep", () => {
    const arc: SketchArcEntity = { ...createArc(vec2(0, 0), 5, 0, Math.PI / 2), id: "a" };
    // Straight down from the centre is outside the sweep; the nearest point on
    // the arc is its start at (5, 0).
    expect(distanceToEntity(arc, vec2(0, -5))).toBeCloseTo(Math.hypot(5, 5), 9);
    expect(distanceToEntity(arc, vec2(0, 8))).toBeCloseTo(3, 9);
  });
});
