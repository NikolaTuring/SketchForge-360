import { describe, expect, it } from "vitest";
import { createMatrix, rankWithPivoting, solveLeastSquares } from "@/lib/sketchSolver/linalg";
import { buildResiduals } from "@/lib/sketchSolver/residuals";
import { buildLayout, packVariables } from "@/lib/sketchSolver/variables";
import { resolveDimensions, solveSketch } from "@/lib/sketchSolver/solve";
import { entityPoint, rectangleEntities, vec2 } from "@/lib/sketchEntities";
import type {
  Sketch,
  SketchArcEntity,
  SketchCircleEntity,
  SketchConstraint,
  SketchEntity,
  SketchLineEntity,
  SketchPointRef,
} from "@/types/sketch";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let constraintCounter = 0;
function constraintId() {
  constraintCounter += 1;
  return `c${constraintCounter}`;
}

function sketchOf(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return {
    id: "s",
    name: "Sketch",
    plane: { kind: "base", plane: "xz", offset: 0 },
    entities,
    constraints,
  };
}

function line(id: string, ax: number, ay: number, bx: number, by: number): SketchLineEntity {
  return { id, type: "line", a: vec2(ax, ay), b: vec2(bx, by) };
}

function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, type: "circle", c: vec2(cx, cy), r };
}

function arc(id: string, cx: number, cy: number, r: number, start: number, end: number): SketchArcEntity {
  return { id, type: "arc", c: vec2(cx, cy), r, startAngle: start, endAngle: end };
}

function ref(entityId: string, role: SketchPointRef["role"]): SketchPointRef {
  return { entityId, role };
}

function dimension(value: number) {
  return { expression: String(value), value };
}

function findLine(entities: SketchEntity[], id: string) {
  return entities.find((entity) => entity.id === id) as SketchLineEntity;
}

// ---------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------

describe("solveLeastSquares", () => {
  it("solves a square system exactly", () => {
    const a = createMatrix(2, 2);
    a.data.set([2, 1, 1, 3]);
    const solution = solveLeastSquares(a, Float64Array.from([5, 10]));
    expect(solution?.[0]).toBeCloseTo(1, 10);
    expect(solution?.[1]).toBeCloseTo(3, 10);
  });

  it("solves an over-determined system in the least-squares sense", () => {
    // Best fit line y = x through (0,0), (1,1), (2,2.2): slope 1.04.
    const a = createMatrix(3, 1);
    a.data.set([0, 1, 2]);
    const solution = solveLeastSquares(a, Float64Array.from([0, 1, 2.2]));
    expect(solution?.[0]).toBeCloseTo((0 * 0 + 1 * 1 + 2 * 2.2) / (0 + 1 + 4), 10);
  });

  it("refuses an under-determined system", () => {
    expect(solveLeastSquares(createMatrix(1, 2), Float64Array.from([1]))).toBeNull();
  });
});

describe("rankWithPivoting", () => {
  it("reports full rank for independent columns", () => {
    const a = createMatrix(3, 2);
    a.data.set([1, 0, 0, 1, 0, 0]);
    expect(rankWithPivoting(a).rank).toBe(2);
  });

  it("detects a linearly dependent column", () => {
    const a = createMatrix(3, 3);
    // Third column is the sum of the first two.
    a.data.set([1, 0, 1, 0, 1, 1, 0, 0, 0]);
    expect(rankWithPivoting(a).rank).toBe(2);
  });

  it("reports rank zero for an all-zero matrix", () => {
    expect(rankWithPivoting(createMatrix(3, 3)).rank).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Jacobian correctness
// ---------------------------------------------------------------------------

/**
 * The single most valuable test in the solver: every residual's analytic
 * derivative is compared against a central finite difference. A wrong Jacobian
 * still converges *sometimes*, which makes this class of bug very hard to spot
 * from behaviour alone.
 */
describe("residual Jacobians match central finite differences", () => {
  const cases: { name: string; entities: SketchEntity[]; constraints: SketchConstraint[] }[] = [
    {
      name: "coincident",
      entities: [line("l1", 0, 0, 10, 1), line("l2", 10.2, 0.9, 20, 5)],
      constraints: [{ id: constraintId(), type: "coincident", a: ref("l1", "end"), b: ref("l2", "start") }],
    },
    {
      name: "fix",
      entities: [arc("a1", 1, 2, 5, 0.3, 2.1)],
      constraints: [{ id: constraintId(), type: "fix", point: ref("a1", "start"), at: vec2(6, 3) }],
    },
    {
      name: "horizontal and vertical",
      entities: [line("l1", 0, 0, 10, 1.5), line("l2", 0, 0, 1.2, 9)],
      constraints: [
        { id: constraintId(), type: "horizontal", entity: "l1" },
        { id: constraintId(), type: "vertical", entity: "l2" },
      ],
    },
    {
      name: "parallel and perpendicular",
      entities: [line("l1", 0, 0, 10, 2), line("l2", 0, 5, 9, 3), line("l3", 1, 1, 2, 8)],
      constraints: [
        { id: constraintId(), type: "parallel", a: "l1", b: "l2" },
        { id: constraintId(), type: "perpendicular", a: "l1", b: "l3" },
      ],
    },
    {
      name: "equal lines and equal radii",
      entities: [line("l1", 0, 0, 10, 2), line("l2", 0, 5, 7, 3), circle("c1", 0, 0, 4), arc("a1", 3, 3, 5.5, 0.2, 1.9)],
      constraints: [
        { id: constraintId(), type: "equal", a: "l1", b: "l2" },
        { id: constraintId(), type: "equal", a: "c1", b: "a1" },
      ],
    },
    {
      name: "concentric",
      entities: [circle("c1", 0, 0, 4), arc("a1", 1.2, 0.4, 6, 0.1, 2.4)],
      constraints: [{ id: constraintId(), type: "concentric", a: "c1", b: "a1" }],
    },
    {
      name: "midpoint",
      entities: [line("l1", 0, 0, 10, 4), { id: "p1", type: "point", p: vec2(4.6, 2.3) }],
      constraints: [{ id: constraintId(), type: "midpoint", point: ref("p1", "point"), line: "l1" }],
    },
    {
      name: "point on line and point on circle",
      entities: [line("l1", 0, 0, 10, 4), circle("c1", 20, 0, 5), { id: "p1", type: "point", p: vec2(4.6, 2.9) }, { id: "p2", type: "point", p: vec2(24, 1.5) }],
      constraints: [
        { id: constraintId(), type: "pointOnEntity", point: ref("p1", "point"), entity: "l1" },
        { id: constraintId(), type: "pointOnEntity", point: ref("p2", "point"), entity: "c1" },
      ],
    },
    {
      name: "tangent line to circle",
      entities: [line("l1", -10, 6.2, 10, 5.4), circle("c1", 0, 0, 5)],
      constraints: [{ id: constraintId(), type: "tangent", a: "l1", b: "c1" }],
    },
    {
      name: "tangent circle to circle",
      entities: [circle("c1", 0, 0, 5), circle("c2", 12.4, 0.6, 7)],
      constraints: [{ id: constraintId(), type: "tangent", a: "c1", b: "c2" }],
    },
    {
      name: "symmetric",
      entities: [line("axis", 0, -10, 0.4, 10), { id: "p1", type: "point", p: vec2(-6, 2) }, { id: "p2", type: "point", p: vec2(6.3, 2.4) }],
      constraints: [{ id: constraintId(), type: "symmetric", a: ref("p1", "point"), b: ref("p2", "point"), axis: "axis" }],
    },
    {
      name: "distance dimensions",
      entities: [line("l1", 0, 0, 9.4, 3.2)],
      constraints: [
        { id: constraintId(), type: "distance", a: ref("l1", "start"), b: ref("l1", "end"), value: dimension(10) },
        { id: constraintId(), type: "horizontalDistance", a: ref("l1", "start"), b: ref("l1", "end"), value: dimension(9) },
        { id: constraintId(), type: "verticalDistance", a: ref("l1", "start"), b: ref("l1", "end"), value: dimension(3) },
      ],
    },
    {
      name: "point to line distance",
      entities: [line("l1", 0, 0, 10, 1), { id: "p1", type: "point", p: vec2(4, 6.2) }],
      constraints: [{ id: constraintId(), type: "pointLineDistance", point: ref("p1", "point"), line: "l1", value: dimension(6) }],
    },
    {
      name: "radius and diameter",
      entities: [circle("c1", 0, 0, 4.3), arc("a1", 8, 0, 2.6, 0.2, 2.2)],
      constraints: [
        { id: constraintId(), type: "radius", entity: "c1", value: dimension(5) },
        { id: constraintId(), type: "diameter", entity: "a1", value: dimension(6) },
      ],
    },
    {
      name: "angle",
      entities: [line("l1", 0, 0, 10, 0.4), line("l2", 0, 0, 3, 9.1)],
      constraints: [{ id: constraintId(), type: "angle", a: "l1", b: "l2", value: dimension(60) }],
    },
    {
      name: "spline endpoint coincidence",
      entities: [
        { id: "sp1", type: "spline", ctrl: [vec2(0, 0), vec2(3, 4), vec2(7, 4), vec2(10, 0)], degree: 3 },
        line("l1", 10.3, 0.2, 20, 0),
      ],
      constraints: [{ id: constraintId(), type: "coincident", a: ref("sp1", "end"), b: ref("l1", "start") }],
    },
  ];

  cases.forEach(({ name, entities, constraints }) => {
    it(name, () => {
      const layout = buildLayout(entities);
      const values = packVariables(layout);
      const scale = 20;
      const base = buildResiduals(layout, values, constraints, scale);

      expect(base.unsupported).toHaveLength(0);
      expect(base.rows.length).toBeGreaterThan(0);

      const step = 1e-6;
      for (let column = 0; column < layout.count; column += 1) {
        const forward = new Float64Array(values);
        const backward = new Float64Array(values);
        forward[column] += step;
        backward[column] -= step;

        const forwardRows = buildResiduals(layout, forward, constraints, scale).rows;
        const backwardRows = buildResiduals(layout, backward, constraints, scale).rows;

        base.rows.forEach((row, index) => {
          const numeric = (forwardRows[index].residual.value - backwardRows[index].residual.value) / (2 * step);
          const analytic = row.residual.grad.get(column) ?? 0;
          // Absolute tolerance scaled by the derivative magnitude keeps this
          // meaningful for both millimetre-sized and unit-sized rows.
          expect(Math.abs(analytic - numeric)).toBeLessThan(1e-5 * Math.max(1, Math.abs(numeric)));
        });
      }
    });
  });

  it("reports unsupported constraint combinations instead of throwing", () => {
    const entities = [line("l1", 0, 0, 10, 0), circle("c1", 0, 0, 5)];
    const build = buildResiduals(buildLayout(entities), packVariables(buildLayout(entities)), [
      { id: "bad", type: "equal", a: "l1", b: "c1" },
      { id: "missing", type: "horizontal", entity: "nope" },
    ], 10);

    expect(build.rows).toHaveLength(0);
    expect(build.unsupported.map((entry) => entry.constraintId).sort()).toEqual(["bad", "missing"]);
  });
});

// ---------------------------------------------------------------------------
// Solving
// ---------------------------------------------------------------------------

describe("solveSketch degrees of freedom", () => {
  it("counts four degrees of freedom for a plain rectangle", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const result = solveSketch(sketchOf(entities, constraints));

    // 16 variables − 12 independent constraints = position (2) + width + height.
    expect(result.degreesOfFreedom).toBe(4);
    expect(result.status).toBe("under-constrained");
    expect(result.residualNorm).toBeLessThan(1e-7);
  });

  it("reaches zero degrees of freedom once size and position are dimensioned", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const [bottom, right] = entities as SketchLineEntity[];

    const result = solveSketch(
      sketchOf(entities, [
        ...constraints,
        { id: constraintId(), type: "fix", point: ref(bottom.id, "start"), at: vec2(0, 0) },
        { id: constraintId(), type: "distance", a: ref(bottom.id, "start"), b: ref(bottom.id, "end"), value: dimension(35) },
        { id: constraintId(), type: "distance", a: ref(right.id, "start"), b: ref(right.id, "end"), value: dimension(18) },
      ]),
    );

    expect(result.status).toBe("solved");
    expect(result.degreesOfFreedom).toBe(0);
    expect(result.fullyConstrained).toBe(true);

    const solvedBottom = findLine(result.entities, bottom.id);
    expect(Math.hypot(solvedBottom.b.x - solvedBottom.a.x, solvedBottom.b.y - solvedBottom.a.y)).toBeCloseTo(35, 6);
    const solvedRight = findLine(result.entities, right.id);
    expect(Math.hypot(solvedRight.b.x - solvedRight.a.x, solvedRight.b.y - solvedRight.a.y)).toBeCloseTo(18, 6);
    expect(solvedBottom.a.x).toBeCloseTo(0, 6);
    expect(solvedBottom.a.y).toBeCloseTo(0, 6);
  });

  it("keeps the rectangle closed after solving", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const result = solveSketch(
      sketchOf(entities, [
        ...constraints,
        { id: constraintId(), type: "distance", a: ref(entities[0].id, "start"), b: ref(entities[0].id, "end"), value: dimension(40) },
      ]),
    );

    const lines = result.entities as SketchLineEntity[];
    lines.forEach((current, index) => {
      const next = lines[(index + 1) % lines.length];
      expect(current.b.x).toBeCloseTo(next.a.x, 6);
      expect(current.b.y).toBeCloseTo(next.a.y, 6);
    });
  });
});

describe("solveSketch geometric constraints", () => {
  it("makes a line tangent to a circle", () => {
    const entities = [line("l1", -20, 8, 20, 8), circle("c1", 0, 0, 5)];
    const result = solveSketch(
      sketchOf(entities, [
        { id: constraintId(), type: "horizontal", entity: "l1" },
        { id: constraintId(), type: "tangent", a: "l1", b: "c1" },
        { id: constraintId(), type: "radius", entity: "c1", value: dimension(5) },
        { id: constraintId(), type: "fix", point: ref("c1", "center"), at: vec2(0, 0) },
      ]),
    );

    expect(result.residualNorm).toBeLessThan(1e-6);
    const solved = findLine(result.entities, "l1");
    // A horizontal tangent above a circle of radius 5 centred at the origin sits at y = 5.
    expect(Math.abs(solved.a.y)).toBeCloseTo(5, 5);
    expect(solved.a.y).toBeCloseTo(solved.b.y, 6);
  });

  it("makes two circles concentric and equal", () => {
    const entities = [circle("c1", 0, 0, 4), circle("c2", 3, 2, 9)];
    const result = solveSketch(
      sketchOf(entities, [
        { id: constraintId(), type: "concentric", a: "c1", b: "c2" },
        { id: constraintId(), type: "equal", a: "c1", b: "c2" },
      ]),
    );

    const [first, second] = result.entities as SketchCircleEntity[];
    expect(first.c.x).toBeCloseTo(second.c.x, 6);
    expect(first.c.y).toBeCloseTo(second.c.y, 6);
    expect(first.r).toBeCloseTo(second.r, 6);
  });

  it("applies an angle dimension between two lines", () => {
    const entities = [line("l1", 0, 0, 10, 0), line("l2", 0, 0, 10, 1)];
    const result = solveSketch(
      sketchOf(entities, [
        { id: constraintId(), type: "coincident", a: ref("l1", "start"), b: ref("l2", "start") },
        { id: constraintId(), type: "horizontal", entity: "l1" },
        { id: constraintId(), type: "angle", a: "l1", b: "l2", value: dimension(30) },
      ]),
    );

    const second = findLine(result.entities, "l2");
    const angle = (Math.atan2(second.b.y - second.a.y, second.b.x - second.a.x) * 180) / Math.PI;
    expect(angle).toBeCloseTo(30, 4);
  });

  it("keeps an arc's endpoints on its own circle", () => {
    const entities = [arc("a1", 0, 0, 5, 0, Math.PI / 2)];
    const result = solveSketch(
      sketchOf(entities, [{ id: constraintId(), type: "radius", entity: "a1", value: dimension(12) }]),
    );

    const solved = result.entities[0] as SketchArcEntity;
    expect(solved.r).toBeCloseTo(12, 6);
    const start = entityPoint(solved, "start");
    const end = entityPoint(solved, "end");
    expect(Math.hypot((start?.x ?? 0) - solved.c.x, (start?.y ?? 0) - solved.c.y)).toBeCloseTo(12, 6);
    expect(Math.hypot((end?.x ?? 0) - solved.c.x, (end?.y ?? 0) - solved.c.y)).toBeCloseTo(12, 6);
  });

  it("mirrors a point across a symmetry axis", () => {
    const entities = [line("axis", 0, -10, 0, 10), { id: "p1", type: "point" as const, p: vec2(-6, 2) }, { id: "p2", type: "point" as const, p: vec2(4, 5) }];
    const result = solveSketch(
      sketchOf(entities, [
        { id: constraintId(), type: "vertical", entity: "axis" },
        { id: constraintId(), type: "fix", point: ref("axis", "start"), at: vec2(0, -10) },
        { id: constraintId(), type: "fix", point: ref("p1", "point"), at: vec2(-6, 2) },
        { id: constraintId(), type: "symmetric", a: ref("p1", "point"), b: ref("p2", "point"), axis: "axis" },
      ]),
    );

    const mirrored = result.entities.find((entity) => entity.id === "p2");
    expect(mirrored?.type).toBe("point");
    if (mirrored?.type === "point") {
      expect(mirrored.p.x).toBeCloseTo(6, 5);
      expect(mirrored.p.y).toBeCloseTo(2, 5);
    }
  });
});

describe("solveSketch diagnostics", () => {
  it("flags a redundant constraint that is implied by the others", () => {
    const entities = [line("l1", 0, 0, 10, 0), line("l2", 0, 5, 10, 5)];
    const redundant = constraintId();
    const result = solveSketch(
      sketchOf(entities, [
        { id: constraintId(), type: "horizontal", entity: "l1" },
        { id: constraintId(), type: "horizontal", entity: "l2" },
        // Two horizontal lines are already parallel.
        { id: redundant, type: "parallel", a: "l1", b: "l2" },
      ]),
    );

    expect(result.status).toBe("over-constrained");
    expect(result.redundantConstraintIds).toContain(redundant);
    expect(result.conflictingConstraintIds).toHaveLength(0);
    expect(result.residualNorm).toBeLessThan(1e-6);
  });

  it("reports conflicting dimensions that cannot both hold", () => {
    const entities = [line("l1", 0, 0, 10, 0)];
    const result = solveSketch(
      sketchOf(entities, [
        { id: constraintId(), type: "horizontal", entity: "l1" },
        { id: constraintId(), type: "distance", a: ref("l1", "start"), b: ref("l1", "end"), value: dimension(10) },
        { id: constraintId(), type: "horizontalDistance", a: ref("l1", "start"), b: ref("l1", "end"), value: dimension(25) },
      ]),
    );

    expect(result.status).toBe("inconsistent");
    expect(result.residualNorm).toBeGreaterThan(1e-3);
  });

  it("marks a sketch with an unsupported constraint as invalid", () => {
    const result = solveSketch(
      sketchOf([line("l1", 0, 0, 10, 0), circle("c1", 0, 0, 5)], [{ id: "bad", type: "equal", a: "l1", b: "c1" }]),
    );

    expect(result.status).toBe("invalid");
    expect(result.unsupported).toHaveLength(1);
  });

  it("treats an empty sketch as solved", () => {
    const result = solveSketch(sketchOf([], []));
    expect(result.status).toBe("solved");
    expect(result.degreesOfFreedom).toBe(0);
  });
});

describe("solveSketch dragging", () => {
  it("moves a dragged point toward the cursor while honouring constraints", () => {
    const entities = [line("l1", 0, 0, 10, 0)];
    const constraints: SketchConstraint[] = [
      { id: constraintId(), type: "horizontal", entity: "l1" },
      { id: constraintId(), type: "fix", point: ref("l1", "start"), at: vec2(0, 0) },
    ];

    const result = solveSketch(sketchOf(entities, constraints), {
      drag: { point: ref("l1", "end"), target: vec2(30, 12) },
    });

    const solved = findLine(result.entities, "l1");
    // The horizontal constraint wins on Y; the free X follows the cursor.
    expect(solved.a.x).toBeCloseTo(0, 4);
    expect(solved.a.y).toBeCloseTo(0, 4);
    expect(solved.b.y).toBeCloseTo(0, 4);
    expect(solved.b.x).toBeGreaterThan(20);
  });

  it("leaves unconstrained geometry where it was instead of drifting", () => {
    const entities = [line("l1", 0, 0, 10, 0), line("far", 100, 100, 110, 100)];
    const result = solveSketch(sketchOf(entities, [{ id: constraintId(), type: "horizontal", entity: "l1" }]), {
      drag: { point: ref("l1", "end"), target: vec2(25, 0) },
    });

    const untouched = findLine(result.entities, "far");
    expect(untouched.a.x).toBeCloseTo(100, 6);
    expect(untouched.a.y).toBeCloseTo(100, 6);
    expect(untouched.b.x).toBeCloseTo(110, 6);
  });

  it("skips the rank analysis when diagnostics are disabled", () => {
    const { entities, constraints } = rectangleEntities(vec2(0, 0), vec2(20, 10));
    const result = solveSketch(sketchOf(entities, constraints), { skipDiagnostics: true });
    expect(result.degreesOfFreedom).toBe(0);
    expect(result.redundantConstraintIds).toHaveLength(0);
  });
});

describe("resolveDimensions", () => {
  it("re-evaluates dimension expressions against the parameter table", () => {
    const constraints: SketchConstraint[] = [
      { id: "d1", type: "radius", entity: "c1", value: { expression: "bore / 2", value: 0 } },
    ];
    const { constraints: resolved, errors } = resolveDimensions(constraints, new Map([["bore", 12]]));

    expect(errors.size).toBe(0);
    expect(resolved[0].type === "radius" && resolved[0].value.value).toBe(6);
  });

  it("keeps the last good value and reports the error when an expression breaks", () => {
    const constraints: SketchConstraint[] = [
      { id: "d1", type: "radius", entity: "c1", value: { expression: "missing * 2", value: 7 } },
    ];
    const { constraints: resolved, errors } = resolveDimensions(constraints);

    expect(errors.get("d1")).toMatch(/Unknown parameter/);
    expect(resolved[0].type === "radius" && resolved[0].value.value).toBe(7);
  });

  it("drives sketch geometry from a named parameter", () => {
    const entities = [circle("c1", 0, 0, 3)];
    const result = solveSketch(
      sketchOf(entities, [{ id: "d1", type: "radius", entity: "c1", value: { expression: "bore / 2", value: 3 } }]),
      { parameterScope: new Map([["bore", 25]]) },
    );

    expect((result.entities[0] as SketchCircleEntity).r).toBeCloseTo(12.5, 6);
    expect(result.dimensionErrors.size).toBe(0);
  });
});
