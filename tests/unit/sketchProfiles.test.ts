import { describe, expect, it } from "vitest";
import {
  discretizeEntity,
  findSketchRegions,
  pointInPolygon,
  regionArea,
  signedArea,
} from "@/lib/sketchProfiles";
import { polygonEntities, rectangleEntities, slotEntities, vec2 } from "@/lib/sketchEntities";
import type { SketchEntity } from "@/types/sketch";

function line(id: string, ax: number, ay: number, bx: number, by: number): SketchEntity {
  return { id, type: "line", a: vec2(ax, ay), b: vec2(bx, by) };
}

function circle(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, type: "circle", c: vec2(cx, cy), r };
}

function closedRectangle(prefix: string, x0: number, y0: number, x1: number, y1: number): SketchEntity[] {
  return [
    line(`${prefix}-b`, x0, y0, x1, y0),
    line(`${prefix}-r`, x1, y0, x1, y1),
    line(`${prefix}-t`, x1, y1, x0, y1),
    line(`${prefix}-l`, x0, y1, x0, y0),
  ];
}

describe("discretizeEntity", () => {
  it("returns the two endpoints of a line", () => {
    expect(discretizeEntity(line("l", 0, 0, 10, 5))).toEqual([vec2(0, 0), vec2(10, 5)]);
  });

  it("samples a circle within the requested chord tolerance", () => {
    const points = discretizeEntity(circle("c", 0, 0, 50), { tolerance: 0.01 });
    points.forEach((point) => expect(Math.hypot(point.x, point.y)).toBeCloseTo(50, 9));

    // Every chord's sagitta must stay inside the tolerance.
    for (let index = 0; index + 1 < points.length; index += 1) {
      const chord = Math.hypot(points[index + 1].x - points[index].x, points[index + 1].y - points[index].y);
      const sagitta = 50 - Math.sqrt(Math.max(0, 50 * 50 - (chord / 2) ** 2));
      expect(sagitta).toBeLessThanOrEqual(0.0101);
    }
  });

  it("samples an arc between its own endpoints", () => {
    const points = discretizeEntity({ id: "a", type: "arc", c: vec2(0, 0), r: 10, startAngle: 0, endAngle: Math.PI / 2 });
    expect(points[0].x).toBeCloseTo(10, 9);
    expect(points[0].y).toBeCloseTo(0, 9);
    expect(points[points.length - 1].x).toBeCloseTo(0, 9);
    expect(points[points.length - 1].y).toBeCloseTo(10, 9);
  });

  it("samples a cubic spline through its end control points", () => {
    const points = discretizeEntity({
      id: "s",
      type: "spline",
      ctrl: [vec2(0, 0), vec2(0, 10), vec2(10, 10), vec2(10, 0)],
      degree: 3,
    });
    expect(points[0]).toEqual(vec2(0, 0));
    expect(points[points.length - 1].x).toBeCloseTo(10, 9);
    expect(points[points.length - 1].y).toBeCloseTo(0, 9);
  });
});

describe("signedArea and pointInPolygon", () => {
  it("is positive for a counter-clockwise polygon", () => {
    expect(signedArea([vec2(0, 0), vec2(10, 0), vec2(10, 10), vec2(0, 10)])).toBeCloseTo(100, 9);
    expect(signedArea([vec2(0, 0), vec2(0, 10), vec2(10, 10), vec2(10, 0)])).toBeCloseTo(-100, 9);
  });

  it("classifies points inside and outside", () => {
    const square = [vec2(0, 0), vec2(10, 0), vec2(10, 10), vec2(0, 10)];
    expect(pointInPolygon(vec2(5, 5), square)).toBe(true);
    expect(pointInPolygon(vec2(15, 5), square)).toBe(false);
  });
});

describe("findSketchRegions", () => {
  it("finds a single region from a closed chain of lines", () => {
    const result = findSketchRegions(closedRectangle("r", 0, 0, 20, 10));

    expect(result.issues).toHaveLength(0);
    expect(result.openEntityIds).toHaveLength(0);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.segments).toHaveLength(4);
    expect(result.regions[0].outerLoop.area).toBeCloseTo(200, 6);
    expect(result.regions[0].innerLoops).toHaveLength(0);
  });

  it("orients the outer loop counter-clockwise regardless of how it was drawn", () => {
    const clockwise = [
      line("a", 0, 0, 0, 10),
      line("b", 0, 10, 20, 10),
      line("c", 20, 10, 20, 0),
      line("d", 20, 0, 0, 0),
    ];
    const result = findSketchRegions(clockwise);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.area).toBeGreaterThan(0);
  });

  it("treats a circle as its own region", () => {
    // A loop's `points` are a polyline approximation used only for area and
    // containment; the exact geometry stays on the referenced entity. A finer
    // chord tolerance therefore converges the area on the true one.
    const result = findSketchRegions([circle("c", 0, 0, 10)], { tolerance: 0.001 });
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.segments).toEqual([{ entityId: "c", reversed: false }]);
    expect(result.regions[0].outerLoop.area).toBeCloseTo(Math.PI * 100, 0);
  });

  it("nests a circle inside a rectangle as a hole", () => {
    const result = findSketchRegions([...closedRectangle("r", 0, 0, 40, 30), circle("hole", 20, 15, 5)]);

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].innerLoops).toHaveLength(1);
    expect(result.regions[0].innerLoops[0].segments[0].entityId).toBe("hole");
    expect(regionArea(result.regions[0])).toBeCloseTo(40 * 30 - Math.PI * 25, 0);
  });

  it("treats an island inside a hole as its own region", () => {
    const result = findSketchRegions([
      ...closedRectangle("outer", 0, 0, 100, 100),
      circle("hole", 50, 50, 30),
      circle("island", 50, 50, 10),
    ]);

    expect(result.regions).toHaveLength(2);
    const outer = result.regions.find((region) => region.outerLoop.segments.some((segment) => segment.entityId.startsWith("outer")));
    const island = result.regions.find((region) => region.outerLoop.segments[0].entityId === "island");
    expect(outer?.innerLoops.map((loop) => loop.segments[0].entityId)).toEqual(["hole"]);
    expect(island?.innerLoops).toHaveLength(0);
  });

  it("finds two disjoint regions", () => {
    const result = findSketchRegions([...closedRectangle("a", 0, 0, 10, 10), ...closedRectangle("b", 50, 0, 60, 10)]);
    expect(result.regions).toHaveLength(2);
    result.regions.forEach((region) => expect(region.outerLoop.area).toBeCloseTo(100, 6));
  });

  it("splits a figure that shares an edge into two minimal regions", () => {
    // Two squares sharing the middle vertical edge.
    const result = findSketchRegions([
      line("bottom-left", 0, 0, 10, 0),
      line("bottom-right", 10, 0, 20, 0),
      line("right", 20, 0, 20, 10),
      line("top-right", 20, 10, 10, 10),
      line("top-left", 10, 10, 0, 10),
      line("left", 0, 10, 0, 0),
      line("middle", 10, 0, 10, 10),
    ]);

    expect(result.regions).toHaveLength(2);
    result.regions.forEach((region) => expect(region.outerLoop.area).toBeCloseTo(100, 6));
  });

  it("reports geometry that does not close a region", () => {
    const result = findSketchRegions([line("a", 0, 0, 10, 0), line("b", 10, 0, 10, 10)]);

    expect(result.regions).toHaveLength(0);
    expect(result.openEntityIds.sort()).toEqual(["a", "b"]);
    expect(result.issues.some((issue) => issue.kind === "open-chain")).toBe(true);
  });

  it("reports a dangling tail without losing the closed region it hangs off", () => {
    const result = findSketchRegions([...closedRectangle("r", 0, 0, 20, 10), line("tail", 20, 10, 40, 25)]);

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.area).toBeCloseTo(200, 6);
    // The tail encloses nothing, so it is open geometry even though it touches
    // a closed region.
    expect(result.openEntityIds).toEqual(["tail"]);
  });

  it("ignores construction geometry and standalone points", () => {
    const result = findSketchRegions([
      ...closedRectangle("r", 0, 0, 20, 10),
      { ...(line("guide", -5, 5, 25, 5) as SketchEntity), construction: true },
      { id: "p", type: "point", p: vec2(5, 5) },
    ]);

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.segments).toHaveLength(4);
    expect(result.issues).toHaveLength(0);
  });

  it("closes the region built by the rectangle tool", () => {
    const result = findSketchRegions(rectangleEntities(vec2(0, 0), vec2(30, 12)).entities);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.area).toBeCloseTo(360, 6);
  });

  it("closes the region built by the polygon tool", () => {
    const result = findSketchRegions(polygonEntities(vec2(0, 0), 10, 6).entities);
    expect(result.regions).toHaveLength(1);
    // Regular hexagon inscribed in r = 10 has area 3·√3/2·r².
    expect(result.regions[0].outerLoop.area).toBeCloseTo((3 * Math.sqrt(3) * 100) / 2, 4);
  });

  it("closes the region built by the slot tool, arcs included", () => {
    const result = findSketchRegions(slotEntities(vec2(0, 0), vec2(30, 0), 5).entities, { tolerance: 0.001 });

    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].outerLoop.segments).toHaveLength(4);
    // Rectangle 30×10 plus a full circle of radius 5 from the two end caps.
    expect(result.regions[0].outerLoop.area).toBeCloseTo(30 * 10 + Math.PI * 25, 0);
    // Both end caps must bulge outwards, so the slot is longer than its axis.
    const extentX = result.regions[0].outerLoop.points.map((point) => point.x);
    expect(Math.min(...extentX)).toBeCloseTo(-5, 2);
    expect(Math.max(...extentX)).toBeCloseTo(35, 2);
  });

  it("keeps the analytic entity behind every loop segment", () => {
    const result = findSketchRegions(slotEntities(vec2(0, 0), vec2(30, 0), 5).entities);
    const ids = result.regions[0].outerLoop.segments.map((segment) => segment.entityId);
    expect(new Set(ids).size).toBe(4);
    ids.forEach((id) => expect(typeof id).toBe("string"));
  });

  it("reports crossing loops rather than silently reinterpreting them", () => {
    const result = findSketchRegions([...closedRectangle("a", 0, 0, 20, 20), ...closedRectangle("b", 10, 10, 30, 30)]);
    expect(result.issues.some((issue) => issue.kind === "self-intersection")).toBe(true);
  });
});
