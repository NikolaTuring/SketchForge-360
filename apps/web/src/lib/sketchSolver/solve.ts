// The sketch constraint solver.
//
// Levenberg–Marquardt over the residuals in `residuals.ts`, plus the rank
// analysis that produces the degrees-of-freedom counter and the
// redundant/conflicting constraint reports.
//
// Two details make the difference between a solver that is correct and one that
// also feels good to use:
//
//   - a weak pull back toward the previous solution, so the degrees of freedom
//     nobody has constrained stay where the user left them instead of jumping
//     to whatever the linear algebra happens to prefer;
//   - an optional drag target, added as an extra soft residual, so dragging a
//     point moves the sketch to the constrained position nearest the cursor.

import { evaluateExpression } from "@/lib/parameterExpressions";
import { normalizeArcAngles } from "@/lib/sketchEntities";
import { createMatrix, solveLeastSquares, type Matrix } from "@/lib/sketchSolver/linalg";
import { buildResiduals, type UnsupportedConstraint } from "@/lib/sketchSolver/residuals";
import {
  buildLayout,
  evaluatePointRef,
  packVariables,
  unpackVariables,
  type VariableLayout,
} from "@/lib/sketchSolver/variables";
import { writeGradientRow } from "@/lib/sketchSolver/autodiff";
import { isDimensionConstraint, type Sketch, type SketchConstraint, type SketchEntity, type SketchPointRef, type Vec2 } from "@/types/sketch";

export type SolveStatus =
  | "solved"
  | "under-constrained"
  | "over-constrained"
  | "inconsistent"
  | "invalid";

export type DragTarget = { point: SketchPointRef; target: Vec2; weight?: number };

export type SolveOptions = {
  maxIterations?: number;
  /** Convergence threshold on the largest residual, in millimetres. */
  tolerance?: number;
  drag?: DragTarget;
  /**
   * Extra pull back toward the incoming geometry. Off by default: the
   * Levenberg–Marquardt damping already produces minimum-norm steps, which is
   * what keeps unconstrained geometry still, and an explicit penalty term would
   * bias the converged solution away from the dimensions the user typed.
   */
  regularization?: number;
  /** Resolved parameter values, for dimensions driven by an expression. */
  parameterScope?: ReadonlyMap<string, number>;
  /** Skip the rank analysis when only the geometry is needed (drag frames). */
  skipDiagnostics?: boolean;
};

export type SolveResult = {
  entities: SketchEntity[];
  status: SolveStatus;
  /** Variables minus the rank of the constraint Jacobian. */
  degreesOfFreedom: number;
  fullyConstrained: boolean;
  iterations: number;
  /** Largest absolute residual after the final iteration, in millimetres. */
  residualNorm: number;
  /** Constraints that are implied by others; harmless but worth surfacing. */
  redundantConstraintIds: string[];
  /** Redundant constraints that also cannot be satisfied — the red ones. */
  conflictingConstraintIds: string[];
  unsupported: UnsupportedConstraint[];
  /** Dimension id → why its expression could not be evaluated. */
  dimensionErrors: Map<string, string>;
};

const DEFAULT_MAX_ITERATIONS = 80;
const DEFAULT_TOLERANCE = 1e-7;
const DEFAULT_REGULARIZATION = 0;
/**
 * A drag target is a soft residual competing with the hard constraints, so its
 * weight decides how much constraint violation a drag can buy. The residual
 * balance works out at roughly `weight²` millimetres of violation, so 1e-3 keeps
 * constraints exact to ~1e-5 mm while still letting the free degrees of freedom
 * follow the cursor exactly — nothing else in the system constrains them.
 */
const DEFAULT_DRAG_WEIGHT = 1e-3;

/**
 * Re-evaluates every driving dimension against the parameter table.
 *
 * A dimension whose expression is broken keeps its last good numeric value, so
 * one bad parameter degrades a single dimension rather than collapsing the whole
 * sketch.
 */
export function resolveDimensions(
  constraints: readonly SketchConstraint[],
  scope: ReadonlyMap<string, number> = new Map(),
): { constraints: SketchConstraint[]; errors: Map<string, string> } {
  const errors = new Map<string, string>();
  const resolved = constraints.map((constraint) => {
    if (!isDimensionConstraint(constraint)) return constraint;
    const expression = constraint.value.expression.trim();
    if (!expression) return constraint;
    try {
      return { ...constraint, value: { ...constraint.value, value: evaluateExpression(expression, scope) } };
    } catch (error) {
      errors.set(constraint.id, error instanceof Error ? error.message : String(error));
      return constraint;
    }
  });
  return { constraints: resolved, errors };
}

function characteristicLength(entities: readonly SketchEntity[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };

  entities.forEach((entity) => {
    switch (entity.type) {
      case "point":
        include(entity.p.x, entity.p.y);
        break;
      case "line":
        include(entity.a.x, entity.a.y);
        include(entity.b.x, entity.b.y);
        break;
      case "circle":
      case "arc":
        include(entity.c.x - entity.r, entity.c.y - entity.r);
        include(entity.c.x + entity.r, entity.c.y + entity.r);
        break;
      case "spline":
        entity.ctrl.forEach((point) => include(point.x, point.y));
        break;
      default:
        break;
    }
  });

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return 1;
  const diagonal = Math.hypot(maxX - minX, maxY - minY);
  return diagonal > 1e-6 ? diagonal : 1;
}

type System = {
  /** Residual values, negated ready for the right-hand side. */
  residuals: Float64Array;
  jacobian: Matrix;
  constraintIds: string[];
  unsupported: UnsupportedConstraint[];
  /** Rows belonging to real constraints, excluding drag and regularization. */
  constraintRowCount: number;
};

function assembleSystem(
  layout: VariableLayout,
  values: Float64Array,
  constraints: readonly SketchConstraint[],
  scale: number,
  drag: DragTarget | undefined,
  regularization: number,
  previous: Float64Array,
): System {
  const build = buildResiduals(layout, values, constraints, scale);
  const columns = layout.count;

  const dragRows: { residual: ReturnType<typeof buildResiduals>["rows"][number]["residual"] }[] = [];
  if (drag) {
    const point = evaluatePointRef(layout, values, drag.point);
    if (point) {
      const weight = drag.weight ?? DEFAULT_DRAG_WEIGHT;
      dragRows.push({ residual: { value: (point.x.value - drag.target.x) * weight, grad: scaleGrad(point.x.grad, weight) } });
      dragRows.push({ residual: { value: (point.y.value - drag.target.y) * weight, grad: scaleGrad(point.y.grad, weight) } });
    }
  }

  const regularizationRows = regularization > 0 ? columns : 0;
  const rows = build.rows.length + dragRows.length + regularizationRows;
  const jacobian = createMatrix(Math.max(rows, 1), Math.max(columns, 1));
  const residuals = new Float64Array(Math.max(rows, 1));
  const constraintIds: string[] = [];

  build.rows.forEach((row, index) => {
    residuals[index] = row.residual.value;
    writeGradientRow(row.residual, index, columns, jacobian.data);
    constraintIds.push(row.constraintId);
  });

  dragRows.forEach((row, index) => {
    const target = build.rows.length + index;
    residuals[target] = row.residual.value;
    writeGradientRow(row.residual, target, columns, jacobian.data);
  });

  for (let index = 0; index < regularizationRows; index += 1) {
    const target = build.rows.length + dragRows.length + index;
    residuals[target] = (values[index] - previous[index]) * regularization;
    jacobian.data[target * columns + index] = regularization;
  }

  return {
    residuals,
    jacobian,
    constraintIds,
    unsupported: build.unsupported,
    constraintRowCount: build.rows.length,
  };
}

function scaleGrad(grad: ReadonlyMap<number, number>, factor: number) {
  const scaled = new Map<number, number>();
  grad.forEach((derivative, index) => scaled.set(index, derivative * factor));
  return scaled;
}

function maxAbs(values: Float64Array, count: number) {
  let largest = 0;
  for (let index = 0; index < count; index += 1) {
    const magnitude = Math.abs(values[index]);
    if (magnitude > largest) largest = magnitude;
  }
  return largest;
}

function sumSquares(values: Float64Array) {
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index] * values[index];
  }
  return total;
}

/**
 * Restores the invariants the rest of the app relies on: radii stay positive and
 * arcs still sweep counter-clockwise. The solver is free to walk a radius
 * through zero on its way to a solution, so this is applied once at the end.
 */
function normalizeSolvedEntities(entities: SketchEntity[]): SketchEntity[] {
  return entities.map((entity) => {
    if (entity.type === "arc") {
      const flipped = entity.r < 0;
      const radius = Math.abs(entity.r);
      const startAngle = flipped ? entity.startAngle + Math.PI : entity.startAngle;
      const endAngle = flipped ? entity.endAngle + Math.PI : entity.endAngle;
      return { ...entity, r: radius, ...normalizeArcAngles(startAngle, endAngle) };
    }
    if (entity.type === "circle") {
      return { ...entity, r: Math.abs(entity.r) };
    }
    return entity;
  });
}

export function solveSketch(sketch: Sketch, options: SolveOptions = {}): SolveResult {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const regularization = options.regularization ?? DEFAULT_REGULARIZATION;

  const { constraints, errors: dimensionErrors } = resolveDimensions(sketch.constraints, options.parameterScope);
  const layout = buildLayout(sketch.entities);
  const scale = characteristicLength(sketch.entities);

  if (layout.count === 0) {
    return {
      entities: [...sketch.entities],
      status: constraints.length > 0 ? "invalid" : "solved",
      degreesOfFreedom: 0,
      fullyConstrained: true,
      iterations: 0,
      residualNorm: 0,
      redundantConstraintIds: [],
      conflictingConstraintIds: [],
      unsupported: [],
      dimensionErrors,
    };
  }

  const previous = packVariables(layout);
  let values = new Float64Array(previous);
  let system = assembleSystem(layout, values, constraints, scale, options.drag, regularization, previous);
  let error = sumSquares(system.residuals);
  let damping = 1e-6 * Math.max(scale, 1);
  let iterations = 0;

  for (; iterations < maxIterations; iterations += 1) {
    if (maxAbs(system.residuals, system.constraintRowCount) <= tolerance && !options.drag) break;

    const columns = layout.count;
    const baseRows = system.jacobian.rows;
    // Stack the damping block underneath so the least-squares system is always
    // full rank; this is what lets a single Householder QR handle an
    // under-constrained sketch without special-casing.
    const augmented = createMatrix(baseRows + columns, columns);
    augmented.data.set(system.jacobian.data, 0);
    const rootDamping = Math.sqrt(damping);
    for (let index = 0; index < columns; index += 1) {
      augmented.data[(baseRows + index) * columns + index] = rootDamping;
    }

    const rightHandSide = new Float64Array(baseRows + columns);
    for (let index = 0; index < baseRows; index += 1) {
      rightHandSide[index] = -system.residuals[index];
    }

    const step = solveLeastSquares(augmented, rightHandSide);
    if (!step) {
      damping *= 10;
      if (damping > 1e12) break;
      continue;
    }

    const candidate = new Float64Array(columns);
    for (let index = 0; index < columns; index += 1) {
      candidate[index] = values[index] + step[index];
    }

    const candidateSystem = assembleSystem(layout, candidate, constraints, scale, options.drag, regularization, previous);
    const candidateError = sumSquares(candidateSystem.residuals);

    if (candidateError < error) {
      const improvement = error - candidateError;
      values = candidate;
      system = candidateSystem;
      error = candidateError;
      damping = Math.max(damping / 3, 1e-12);
      if (improvement < 1e-24 * Math.max(1, error)) break;
    } else {
      damping *= 4;
      if (damping > 1e12) break;
    }
  }

  const solvedEntities = normalizeSolvedEntities(unpackVariables(layout, values));
  const residualNorm = maxAbs(system.residuals, system.constraintRowCount);

  if (options.skipDiagnostics) {
    return {
      entities: solvedEntities,
      status: residualNorm <= tolerance ? "solved" : "inconsistent",
      degreesOfFreedom: 0,
      fullyConstrained: false,
      iterations,
      residualNorm,
      redundantConstraintIds: [],
      conflictingConstraintIds: [],
      unsupported: system.unsupported,
      dimensionErrors,
    };
  }

  const diagnostics = analyzeConstraints(layout, values, constraints, scale, residualNorm, tolerance);

  const status: SolveStatus =
    system.unsupported.length > 0 || dimensionErrors.size > 0
      ? "invalid"
      : residualNorm > tolerance
        ? "inconsistent"
        : diagnostics.redundantConstraintIds.length > 0
          ? "over-constrained"
          : diagnostics.degreesOfFreedom > 0
            ? "under-constrained"
            : "solved";

  return {
    entities: solvedEntities,
    status,
    degreesOfFreedom: diagnostics.degreesOfFreedom,
    fullyConstrained: diagnostics.degreesOfFreedom === 0,
    iterations,
    residualNorm,
    redundantConstraintIds: diagnostics.redundantConstraintIds,
    conflictingConstraintIds: diagnostics.conflictingConstraintIds,
    unsupported: system.unsupported,
    dimensionErrors,
  };
}

type ConstraintDiagnostics = {
  degreesOfFreedom: number;
  redundantConstraintIds: string[];
  conflictingConstraintIds: string[];
};

/**
 * Rank analysis of the constraint Jacobian alone (no drag, no damping).
 *
 * Degrees of freedom are `variables − rank`.
 *
 * Redundancy is a property of a *set* of constraints — with `horizontal(a)`,
 * `horizontal(b)` and `parallel(a, b)` any one of the three is implied by the
 * other two, so an unordered rank routine is free to blame whichever it likes.
 * Users expect the constraint they just added to be the one flagged, so rows are
 * accepted in creation order by modified Gram–Schmidt and only a row that adds
 * nothing to the span of its predecessors is reported.
 */
function analyzeConstraints(
  layout: VariableLayout,
  values: Float64Array,
  constraints: readonly SketchConstraint[],
  scale: number,
  residualNorm: number,
  tolerance: number,
): ConstraintDiagnostics {
  const build = buildResiduals(layout, values, constraints, scale);
  const columns = layout.count;
  const rows = build.rows.length;

  if (rows === 0) {
    return { degreesOfFreedom: columns, redundantConstraintIds: [], conflictingConstraintIds: [] };
  }

  const basis: Float64Array[] = [];
  const dependentRows = new Set<number>();
  const relativeTolerance = 1e-7;

  build.rows.forEach((row, index) => {
    const vector = new Float64Array(columns);
    row.residual.grad.forEach((derivative, column) => {
      if (column >= 0 && column < columns) vector[column] = derivative;
    });

    let originalNorm = 0;
    for (let column = 0; column < columns; column += 1) originalNorm += vector[column] * vector[column];
    originalNorm = Math.sqrt(originalNorm);
    if (originalNorm <= 0) {
      dependentRows.add(index);
      return;
    }

    // Two orthogonalization passes; one pass loses accuracy badly when the new
    // row is nearly inside the existing span, which is exactly the case being
    // tested for here.
    for (let pass = 0; pass < 2; pass += 1) {
      basis.forEach((basisVector) => {
        let projection = 0;
        for (let column = 0; column < columns; column += 1) projection += vector[column] * basisVector[column];
        if (projection === 0) return;
        for (let column = 0; column < columns; column += 1) vector[column] -= projection * basisVector[column];
      });
    }

    let remaining = 0;
    for (let column = 0; column < columns; column += 1) remaining += vector[column] * vector[column];
    remaining = Math.sqrt(remaining);

    if (remaining > relativeTolerance * originalNorm) {
      for (let column = 0; column < columns; column += 1) vector[column] /= remaining;
      basis.push(vector);
    } else {
      dependentRows.add(index);
    }
  });

  const degreesOfFreedom = Math.max(0, columns - basis.length);

  // A multi-row constraint such as `coincident` can contribute one dependent row
  // while the other still carries information, so only report a constraint when
  // every one of its rows is implied.
  const rowsByConstraint = new Map<string, number[]>();
  build.rows.forEach((row, index) => {
    const existing = rowsByConstraint.get(row.constraintId) ?? [];
    existing.push(index);
    rowsByConstraint.set(row.constraintId, existing);
  });

  const redundantConstraintIds: string[] = [];
  rowsByConstraint.forEach((rowIndices, constraintId) => {
    if (rowIndices.every((rowIndex) => dependentRows.has(rowIndex))) redundantConstraintIds.push(constraintId);
  });

  const conflictingConstraintIds = residualNorm > tolerance ? redundantConstraintIds : [];

  return { degreesOfFreedom, redundantConstraintIds, conflictingConstraintIds };
}
