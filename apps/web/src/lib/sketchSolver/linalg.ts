// Dense linear algebra for the sketch solver.
//
// Sketches have well under a thousand variables, so a dense Householder QR is
// both fast enough and considerably more robust than forming the normal
// equations JᵀJ, whose condition number is the square of J's. No dependency is
// added for this: the two routines below are all the solver needs.

export type Matrix = {
  rows: number;
  cols: number;
  /** Row-major, length `rows * cols`. */
  data: Float64Array;
};

export function createMatrix(rows: number, cols: number): Matrix {
  return { rows, cols, data: new Float64Array(rows * cols) };
}

export function transpose(matrix: Matrix): Matrix {
  const result = createMatrix(matrix.cols, matrix.rows);
  for (let row = 0; row < matrix.rows; row += 1) {
    for (let col = 0; col < matrix.cols; col += 1) {
      result.data[col * matrix.rows + row] = matrix.data[row * matrix.cols + col];
    }
  }
  return result;
}

/**
 * Solves min ‖Ax − b‖₂ by Householder QR.
 *
 * `A` must have at least as many rows as columns — the caller guarantees this by
 * appending the Levenberg–Marquardt damping block, which also makes the system
 * full rank. Returns null if the triangular factor is still singular, which the
 * solver treats as "increase damping and retry".
 */
export function solveLeastSquares(a: Matrix, b: Float64Array): Float64Array | null {
  const rows = a.rows;
  const cols = a.cols;
  if (rows < cols) return null;

  const matrix = new Float64Array(a.data);
  const rhs = new Float64Array(b);
  const reflector = new Float64Array(rows);

  for (let k = 0; k < cols; k += 1) {
    let norm = 0;
    for (let row = k; row < rows; row += 1) {
      const value = matrix[row * cols + k];
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) continue;

    // Choose the reflection sign that avoids cancellation in v[0].
    const alpha = matrix[k * cols + k] > 0 ? -norm : norm;
    for (let row = k; row < rows; row += 1) {
      reflector[row] = matrix[row * cols + k];
    }
    reflector[k] -= alpha;

    let reflectorNormSquared = 0;
    for (let row = k; row < rows; row += 1) {
      reflectorNormSquared += reflector[row] * reflector[row];
    }
    if (reflectorNormSquared === 0) continue;

    for (let col = k; col < cols; col += 1) {
      let dot = 0;
      for (let row = k; row < rows; row += 1) {
        dot += reflector[row] * matrix[row * cols + col];
      }
      const factor = (2 * dot) / reflectorNormSquared;
      for (let row = k; row < rows; row += 1) {
        matrix[row * cols + col] -= factor * reflector[row];
      }
    }

    let dot = 0;
    for (let row = k; row < rows; row += 1) {
      dot += reflector[row] * rhs[row];
    }
    const factor = (2 * dot) / reflectorNormSquared;
    for (let row = k; row < rows; row += 1) {
      rhs[row] -= factor * reflector[row];
    }
  }

  const solution = new Float64Array(cols);
  for (let row = cols - 1; row >= 0; row -= 1) {
    const diagonal = matrix[row * cols + row];
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) < 1e-300) return null;
    let sum = rhs[row];
    for (let col = row + 1; col < cols; col += 1) {
      sum -= matrix[row * cols + col] * solution[col];
    }
    solution[row] = sum / diagonal;
  }

  return Number.isFinite(solution[0] ?? 0) && solution.every(Number.isFinite) ? solution : null;
}

export type RankResult = {
  rank: number;
  /**
   * Column indices in the order the pivoting selected them. The first `rank`
   * entries are a maximal linearly independent set; the rest are dependent on
   * them, which is exactly what the redundant-constraint report needs.
   */
  pivots: number[];
};

/**
 * Rank and a linearly independent column set, via Householder QR with column
 * pivoting.
 *
 * `relativeTolerance` is applied against the largest pivot, so the threshold
 * scales with the problem rather than with absolute millimetre magnitudes.
 */
export function rankWithPivoting(a: Matrix, relativeTolerance = 1e-9): RankResult {
  const rows = a.rows;
  const cols = a.cols;
  const steps = Math.min(rows, cols);
  if (steps === 0) return { rank: 0, pivots: [] };

  const matrix = new Float64Array(a.data);
  const pivots = Array.from({ length: cols }, (_unused, index) => index);
  const columnNorms = new Float64Array(cols);
  const reflector = new Float64Array(rows);
  const diagonals: number[] = [];

  for (let col = 0; col < cols; col += 1) {
    let norm = 0;
    for (let row = 0; row < rows; row += 1) {
      const value = matrix[row * cols + col];
      norm += value * value;
    }
    columnNorms[col] = norm;
  }

  for (let k = 0; k < steps; k += 1) {
    let best = k;
    for (let col = k + 1; col < cols; col += 1) {
      if (columnNorms[col] > columnNorms[best]) best = col;
    }
    if (best !== k) {
      for (let row = 0; row < rows; row += 1) {
        const left = row * cols + k;
        const right = row * cols + best;
        const swap = matrix[left];
        matrix[left] = matrix[right];
        matrix[right] = swap;
      }
      const swapNorm = columnNorms[k];
      columnNorms[k] = columnNorms[best];
      columnNorms[best] = swapNorm;
      const swapPivot = pivots[k];
      pivots[k] = pivots[best];
      pivots[best] = swapPivot;
    }

    let norm = 0;
    for (let row = k; row < rows; row += 1) {
      const value = matrix[row * cols + k];
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    if (norm === 0) {
      diagonals.push(0);
      continue;
    }

    const alpha = matrix[k * cols + k] > 0 ? -norm : norm;
    for (let row = k; row < rows; row += 1) {
      reflector[row] = matrix[row * cols + k];
    }
    reflector[k] -= alpha;

    let reflectorNormSquared = 0;
    for (let row = k; row < rows; row += 1) {
      reflectorNormSquared += reflector[row] * reflector[row];
    }
    if (reflectorNormSquared === 0) {
      diagonals.push(0);
      continue;
    }

    for (let col = k; col < cols; col += 1) {
      let dot = 0;
      for (let row = k; row < rows; row += 1) {
        dot += reflector[row] * matrix[row * cols + col];
      }
      const factor = (2 * dot) / reflectorNormSquared;
      for (let row = k; row < rows; row += 1) {
        matrix[row * cols + col] -= factor * reflector[row];
      }
    }

    diagonals.push(Math.abs(matrix[k * cols + k]));

    // Downdate the trailing column norms so the next pivot choice is cheap.
    for (let col = k + 1; col < cols; col += 1) {
      const value = matrix[k * cols + col];
      columnNorms[col] = Math.max(0, columnNorms[col] - value * value);
    }
  }

  const largest = Math.max(...diagonals, 0);
  const threshold = largest * relativeTolerance;
  let rank = 0;
  for (const diagonal of diagonals) {
    if (diagonal > threshold && diagonal > 0) rank += 1;
    else break;
  }

  return { rank, pivots };
}
