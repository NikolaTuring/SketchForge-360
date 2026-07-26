// Forward-mode automatic differentiation with sparse gradients.
//
// Every constraint residual is written as ordinary arithmetic over `Ad` values
// and the exact Jacobian row falls out for free. Hand-writing ~20 analytic
// Jacobians is where constraint solvers traditionally acquire their subtlest
// bugs; this trades a little allocation for derivatives that cannot drift out of
// sync with the residual they belong to.
//
// Gradients are sparse because a residual touches at most a dozen of the
// sketch's variables, however large the sketch grows.

export type Gradient = Map<number, number>;

export type Ad = {
  readonly value: number;
  readonly grad: Gradient;
};

const EMPTY_GRADIENT: Gradient = new Map();

export function constant(value: number): Ad {
  return { value, grad: EMPTY_GRADIENT };
}

export function variable(index: number, value: number): Ad {
  return { value, grad: new Map([[index, 1]]) };
}

function combine(a: Ad, b: Ad, aFactor: number, bFactor: number): Gradient {
  if (a.grad.size === 0 && b.grad.size === 0) return EMPTY_GRADIENT;
  const grad: Gradient = new Map();
  a.grad.forEach((derivative, index) => {
    grad.set(index, derivative * aFactor);
  });
  b.grad.forEach((derivative, index) => {
    const combined = (grad.get(index) ?? 0) + derivative * bFactor;
    if (combined === 0) grad.delete(index);
    else grad.set(index, combined);
  });
  return grad;
}

function scaleGradient(a: Ad, factor: number): Gradient {
  if (a.grad.size === 0 || factor === 0) return EMPTY_GRADIENT;
  const grad: Gradient = new Map();
  a.grad.forEach((derivative, index) => {
    grad.set(index, derivative * factor);
  });
  return grad;
}

export function add(a: Ad, b: Ad): Ad {
  return { value: a.value + b.value, grad: combine(a, b, 1, 1) };
}

export function sub(a: Ad, b: Ad): Ad {
  return { value: a.value - b.value, grad: combine(a, b, 1, -1) };
}

export function neg(a: Ad): Ad {
  return { value: -a.value, grad: scaleGradient(a, -1) };
}

export function scale(a: Ad, factor: number): Ad {
  return { value: a.value * factor, grad: scaleGradient(a, factor) };
}

export function addConstant(a: Ad, offset: number): Ad {
  return { value: a.value + offset, grad: a.grad };
}

export function mul(a: Ad, b: Ad): Ad {
  return { value: a.value * b.value, grad: combine(a, b, b.value, a.value) };
}

export function div(a: Ad, b: Ad): Ad {
  const denominator = b.value;
  // d(a/b) = da/b - a·db/b²
  return { value: a.value / denominator, grad: combine(a, b, 1 / denominator, -a.value / (denominator * denominator)) };
}

export function square(a: Ad): Ad {
  return { value: a.value * a.value, grad: scaleGradient(a, 2 * a.value) };
}

/**
 * Square root with a guarded derivative. At zero the true derivative is
 * infinite; clamping keeps a coincident pair of points from producing NaN steps
 * and lets the solver walk away from the degenerate configuration instead.
 */
export function sqrt(a: Ad, epsilon = 1e-12): Ad {
  const value = Math.sqrt(Math.max(a.value, 0));
  const denominator = 2 * Math.max(value, epsilon);
  return { value, grad: scaleGradient(a, 1 / denominator) };
}

/** Euclidean length of a 2D vector, differentiated safely near zero. */
export function hypot(x: Ad, y: Ad, epsilon = 1e-12): Ad {
  return sqrt(add(square(x), square(y)), epsilon);
}

export function sin(a: Ad): Ad {
  return { value: Math.sin(a.value), grad: scaleGradient(a, Math.cos(a.value)) };
}

export function cos(a: Ad): Ad {
  return { value: Math.cos(a.value), grad: scaleGradient(a, -Math.sin(a.value)) };
}

/**
 * atan2(y, x) with d/dv = (x·dy − y·dx) / (x² + y²).
 * Used for angle dimensions, where it stays smooth as long as the two
 * directions are not both degenerate.
 */
export function atan2(y: Ad, x: Ad, epsilon = 1e-18): Ad {
  const denominator = Math.max(x.value * x.value + y.value * y.value, epsilon);
  return { value: Math.atan2(y.value, x.value), grad: combine(y, x, x.value / denominator, -y.value / denominator) };
}

/** Writes a residual's gradient into one row of a dense row-major Jacobian. */
export function writeGradientRow(residual: Ad, row: number, columns: number, target: Float64Array) {
  const base = row * columns;
  residual.grad.forEach((derivative, index) => {
    if (index >= 0 && index < columns) target[base + index] = derivative;
  });
}
