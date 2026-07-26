import { describe, expect, it } from "vitest";
import {
  arcThroughThreePoints,
  danglingConstraintIds,
  entityPoint,
  frameFromNormal,
  frameNormal,
  legacySketchProfileToSketch,
  normalizeArcAngles,
  polygonEntities,
  rectangleEntities,
  sketchFrame,
  sketchPointToWorld,
  slotEntities,
  vec2,
  worldPointToSketch,
} from "@/lib/sketchEntities";
import type { SketchArcEntity, SketchLineEntity, SketchSplineEntity } from "@/types/sketch";
import type { SketchProfile } from "@/types/sketchforge";

describe("arc angle normalization", () => {
  it("keeps the sweep counter-clockwise and positive", () => {
    expect(normalizeArcAngles(0, Math.PI / 2)).toEqual({ startAngle: 0, endAngle: Math.PI / 2 });
    const wrapped = normalizeArcAngles(Math.PI, 0);
    expect(wrapped.endAngle).toBeGreaterThan(wrapped.startAngle);
    expect(wrapped.endAngle - wrapped.startAngle).toBeCloseTo(Math.PI, 12);
  });

  it("normalizes negative input angles", () => {
    const arc = normalizeArcAngles(-Math.PI / 2, 0);
    expect(arc.startAngle).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(arc.endAngle - arc.startAngle).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe("entityPoint", () => {
  it("derives arc endpoints from centre, radius and angle", () => {
    const arc: SketchArcEntity = { id: "a", type: "arc", c: vec2(10, 5), r: 4, startAngle: 0, endAngle: Math.PI / 2 };
    const start = entityPoint(arc, "start");
    const end = entityPoint(arc, "end");
    expect(start?.x).toBeCloseTo(14, 12);
    expect(start?.y).toBeCloseTo(5, 12);
    expect(end?.x).toBeCloseTo(10, 12);
    expect(end?.y).toBeCloseTo(9, 12);
    expect(entityPoint(arc, "center")).toEqual(vec2(10, 5));
  });

  it("returns the midpoint for a line centre and null for roles that do not apply", () => {
    const line: SketchLineEntity = { id: "l", type: "line", a: vec2(0, 0), b: vec2(10, 4) };
    expect(entityPoint(line, "center")).toEqual(vec2(5, 2));
    expect(entityPoint({ id: "c", type: "circle", c: vec2(1, 2), r: 3 }, "start")).toBeNull();
  });
});

describe("rectangleEntities", () => {
  it("builds four connected lines with alternating horizontal and vertical constraints", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));

    expect(entities).toHaveLength(4);
    expect(entities.every((entity) => entity.type === "line")).toBe(true);
    expect(constraints.filter((constraint) => constraint.type === "coincident")).toHaveLength(4);
    expect(constraints.filter((constraint) => constraint.type === "horizontal")).toHaveLength(2);
    expect(constraints.filter((constraint) => constraint.type === "vertical")).toHaveLength(2);
  });

  it("normalizes the corner order so a rectangle dragged up-left still closes", () => {
    const { entities } = rectangleEntities(vec2(20, 10), vec2(0, 0));
    const lines = entities as SketchLineEntity[];
    expect(lines[0].a).toEqual(vec2(0, 0));
    for (let index = 0; index < lines.length; index += 1) {
      expect(lines[index].b).toEqual(lines[(index + 1) % lines.length].a);
    }
  });
});

describe("polygonEntities", () => {
  it("creates a closed regular polygon with equal-length constraints", () => {
    const { entities, constraints } = polygonEntities(vec2(0, 0), 10, 6);
    expect(entities).toHaveLength(6);
    expect(constraints.filter((constraint) => constraint.type === "coincident")).toHaveLength(6);
    expect(constraints.filter((constraint) => constraint.type === "equal")).toHaveLength(5);

    const lines = entities as SketchLineEntity[];
    const edgeLengths = lines.map((line) => Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y));
    edgeLengths.forEach((length) => expect(length).toBeCloseTo(edgeLengths[0], 10));
  });

  it("places vertices on the circle when inscribed and edges on it when not", () => {
    const inscribed = polygonEntities(vec2(0, 0), 10, 4, true).entities as SketchLineEntity[];
    expect(Math.hypot(inscribed[0].a.x, inscribed[0].a.y)).toBeCloseTo(10, 10);

    const circumscribed = polygonEntities(vec2(0, 0), 10, 4, false).entities as SketchLineEntity[];
    const midpoint = {
      x: (circumscribed[0].a.x + circumscribed[0].b.x) / 2,
      y: (circumscribed[0].a.y + circumscribed[0].b.y) / 2,
    };
    expect(Math.hypot(midpoint.x, midpoint.y)).toBeCloseTo(10, 10);
  });
});

describe("slotEntities", () => {
  it("builds two lines and two arcs joined end to end", () => {
    const { entities, constraints } = slotEntities(vec2(0, 0), vec2(30, 0), 5);

    expect(entities.map((entity) => entity.type)).toEqual(["line", "arc", "line", "arc"]);
    expect(constraints.filter((constraint) => constraint.type === "coincident")).toHaveLength(4);
    expect(constraints.filter((constraint) => constraint.type === "tangent")).toHaveLength(2);

    // Each entity's end must land on the next entity's start for the loop to close.
    entities.forEach((entity, index) => {
      const end = entityPoint(entity, "end");
      const nextStart = entityPoint(entities[(index + 1) % entities.length], "start");
      expect(end?.x).toBeCloseTo(nextStart?.x ?? Number.NaN, 9);
      expect(end?.y).toBeCloseTo(nextStart?.y ?? Number.NaN, 9);
    });
  });

  it("returns nothing for a degenerate slot", () => {
    expect(slotEntities(vec2(0, 0), vec2(0, 0), 5).entities).toHaveLength(0);
    expect(slotEntities(vec2(0, 0), vec2(10, 0), 0).entities).toHaveLength(0);
  });
});

describe("arcThroughThreePoints", () => {
  it("finds the circle through three points and keeps the middle point on the sweep", () => {
    const arc = arcThroughThreePoints(vec2(10, 0), vec2(0, 10), vec2(-10, 0));
    expect(arc).not.toBeNull();
    expect(arc?.r).toBeCloseTo(10, 10);
    expect(arc?.c.x).toBeCloseTo(0, 10);
    expect(arc?.c.y).toBeCloseTo(0, 10);

    const start = entityPoint(arc as SketchArcEntity, "start");
    const end = entityPoint(arc as SketchArcEntity, "end");
    expect(Math.hypot(start?.x ?? 0, start?.y ?? 0)).toBeCloseTo(10, 10);
    expect(Math.hypot(end?.x ?? 0, end?.y ?? 0)).toBeCloseTo(10, 10);
    // The sweep must contain (0, 10) rather than take the long way round.
    expect((arc?.endAngle ?? 0) - (arc?.startAngle ?? 0)).toBeCloseTo(Math.PI, 10);
  });

  it("returns null for collinear points", () => {
    expect(arcThroughThreePoints(vec2(0, 0), vec2(5, 0), vec2(10, 0))).toBeNull();
  });
});

describe("sketch plane frames", () => {
  it("maps the XZ ground plane so sketch (u, v) matches the legacy (x, z)", () => {
    const frame = sketchFrame({ kind: "base", plane: "xz", offset: 0 });
    expect(sketchPointToWorld(frame, vec2(3, 7))).toEqual({ x: 3, y: 0, z: 7 });
  });

  it("offsets a base plane along its own normal", () => {
    const frame = sketchFrame({ kind: "base", plane: "xz", offset: 12 });
    expect(sketchPointToWorld(frame, vec2(0, 0)).y).toBeCloseTo(-12, 12);
  });

  it("round-trips world and sketch coordinates on an arbitrary plane", () => {
    const frame = frameFromNormal({ x: 1, y: 2, z: 3 }, { x: 1, y: 1, z: 1 });
    const original = vec2(4.5, -2.25);
    const roundTripped = worldPointToSketch(frame, sketchPointToWorld(frame, original));
    expect(roundTripped.x).toBeCloseTo(original.x, 10);
    expect(roundTripped.y).toBeCloseTo(original.y, 10);
  });

  it("produces an orthonormal frame whose normal matches the request", () => {
    const normal = { x: 0, y: 1, z: 0 };
    const frame = frameFromNormal({ x: 0, y: 5, z: 0 }, normal);
    const actual = frameNormal(frame);
    expect(actual.x).toBeCloseTo(normal.x, 10);
    expect(actual.y).toBeCloseTo(normal.y, 10);
    expect(actual.z).toBeCloseTo(normal.z, 10);
    expect(Math.hypot(frame.xAxis.x, frame.xAxis.y, frame.xAxis.z)).toBeCloseTo(1, 10);
    expect(frame.xAxis.x * frame.yAxis.x + frame.xAxis.y * frame.yAxis.y + frame.xAxis.z * frame.yAxis.z).toBeCloseTo(0, 10);
  });
});

describe("legacySketchProfileToSketch", () => {
  const closedSquare: SketchProfile = {
    points: [
      { id: "p1", x: 0, z: 0 },
      { id: "p2", x: 10, z: 0 },
      { id: "p3", x: 10, z: 10 },
      { id: "p4", x: 0, z: 10 },
    ],
    segments: [
      { id: "s1", startId: "p1", endId: "p2", kind: "line" },
      { id: "s2", startId: "p2", endId: "p3", kind: "line" },
      { id: "s3", startId: "p3", endId: "p4", kind: "line" },
      { id: "s4", startId: "p4", endId: "p1", kind: "line" },
    ],
  };

  it("turns straight segments into lines on the ground plane", () => {
    const sketch = legacySketchProfileToSketch(closedSquare);
    expect(sketch.entities).toHaveLength(4);
    expect(sketch.entities.every((entity) => entity.type === "line")).toBe(true);
    expect(sketch.plane).toEqual({ kind: "base", plane: "xz", offset: 0 });
  });

  it("preserves chain topology as coincident constraints at shared points", () => {
    const sketch = legacySketchProfileToSketch(closedSquare);
    // Four legacy points, each shared by two segments, so four coincidences.
    expect(sketch.constraints.filter((constraint) => constraint.type === "coincident")).toHaveLength(4);
    expect(sketch.constraints.every((constraint) => constraint.type === "coincident")).toBe(true);
  });

  it("converts curved segments into cubic splines through their handles", () => {
    const sketch = legacySketchProfileToSketch({
      points: [
        { id: "p1", x: 0, z: 0, handleOut: { x: 4, z: 0 } },
        { id: "p2", x: 10, z: 0, handleIn: { x: 6, z: 4 } },
      ],
      segments: [{ id: "s1", startId: "p1", endId: "p2", kind: "bezier" }],
    });

    expect(sketch.entities).toHaveLength(1);
    const spline = sketch.entities[0] as SketchSplineEntity;
    expect(spline.type).toBe("spline");
    expect(spline.degree).toBe(3);
    expect(spline.ctrl).toEqual([vec2(0, 0), vec2(4, 0), vec2(6, 4), vec2(10, 0)]);
  });

  it("keeps isolated points and carries reference images across", () => {
    const image = {
      id: "img",
      name: "ref",
      dataUrl: "data:,",
      mimeType: "image/png",
      pixelWidth: 2,
      pixelHeight: 2,
      x: 0,
      z: 0,
      width: 10,
      depth: 10,
    };
    const sketch = legacySketchProfileToSketch({
      points: [{ id: "lonely", x: 3, z: 4 }],
      segments: [],
      images: [image],
    });

    expect(sketch.entities).toHaveLength(1);
    expect(sketch.entities[0].type).toBe("point");
    expect(sketch.images).toEqual([image]);
  });

  it("skips segments whose endpoints are missing", () => {
    const sketch = legacySketchProfileToSketch({
      points: [{ id: "p1", x: 0, z: 0 }],
      segments: [{ id: "s1", startId: "p1", endId: "gone", kind: "line" }],
    });
    expect(sketch.entities.filter((entity) => entity.type === "line")).toHaveLength(0);
  });
});

describe("danglingConstraintIds", () => {
  it("finds constraints that reference a deleted entity", () => {
    const sketch = legacySketchProfileToSketch(closedSquareFixture());
    const survivor = sketch.entities[0];
    const pruned = { ...sketch, entities: [survivor] };
    expect(danglingConstraintIds(pruned).length).toBeGreaterThan(0);
    expect(danglingConstraintIds(sketch)).toHaveLength(0);
  });
});

function closedSquareFixture(): SketchProfile {
  return {
    points: [
      { id: "p1", x: 0, z: 0 },
      { id: "p2", x: 10, z: 0 },
      { id: "p3", x: 10, z: 10 },
    ],
    segments: [
      { id: "s1", startId: "p1", endId: "p2", kind: "line" },
      { id: "s2", startId: "p2", endId: "p3", kind: "line" },
    ],
  };
}
