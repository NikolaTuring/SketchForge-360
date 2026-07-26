export { buildResiduals, type ResidualBuild, type ResidualRow, type UnsupportedConstraint } from "@/lib/sketchSolver/residuals";
export { resolveDimensions, solveSketch, type DragTarget, type SolveOptions, type SolveResult, type SolveStatus } from "@/lib/sketchSolver/solve";
export {
  buildLayout,
  entityVariableCount,
  evaluateCenter,
  evaluateEntityPoint,
  evaluateLineDirection,
  evaluatePointRef,
  evaluateRadius,
  packVariables,
  unpackVariables,
  type VariableLayout,
} from "@/lib/sketchSolver/variables";
export { createMatrix, rankWithPivoting, solveLeastSquares, transpose, type Matrix, type RankResult } from "@/lib/sketchSolver/linalg";
