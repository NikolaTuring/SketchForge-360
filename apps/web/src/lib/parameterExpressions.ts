// Parametric model parameters and the expression language behind every numeric
// input in the sketcher (dimensions, extrude distances, fillet radii).
//
// The evaluator is a hand-written tokenizer plus recursive-descent parser. It
// deliberately never touches `eval` or `new Function`: expressions arrive from
// `.skf` project files that may have been shared between classrooms, so they are
// untrusted input and must not be able to reach the JavaScript runtime.
//
// Canonical units are millimetres for lengths and degrees for angles, matching
// the rest of SketchForge. A unit suffix on a literal (`1cm`, `30deg`) converts
// to the canonical unit at parse time, so `25mm + 1cm` evaluates to 35.

export type ParameterUnitKind = "length" | "angle" | "unitless";

export type SketchParameter = {
  id: string;
  name: string;
  expression: string;
  unit: ParameterUnitKind;
  comment?: string;
};

export type EvaluatedParameter = SketchParameter & { value: number };

export type ParameterTableResult = {
  /** Successfully evaluated parameters, in the input order. */
  parameters: EvaluatedParameter[];
  /** Resolved values by parameter name, ready to use as an evaluation scope. */
  values: Map<string, number>;
  /** Error message per parameter id for entries that could not be evaluated. */
  errors: Map<string, string>;
};

export class ParameterExpressionError extends Error {
  readonly position: number;

  constructor(message: string, position = -1) {
    super(message);
    this.name = "ParameterExpressionError";
    this.position = position;
  }
}

// Guard rails against pathological input from a shared project file. Real
// parameter expressions are a handful of tokens; these limits are far above any
// legitimate use and keep a malformed file from spending unbounded time here.
const MAX_EXPRESSION_LENGTH = 2000;
const MAX_TOKENS = 1000;
const MAX_DEPTH = 64;

const MILLIMETERS_PER_UNIT: Record<string, number> = {
  mm: 1,
  cm: 10,
  dm: 100,
  m: 1000,
  in: 25.4,
  '"': 25.4,
  ft: 304.8,
  "'": 304.8,
  thou: 0.0254,
  mil: 0.0254,
};

const DEGREES_PER_UNIT: Record<string, number> = {
  deg: 1,
  "°": 1,
  rad: 180 / Math.PI,
  grad: 0.9,
  turn: 360,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

// Trigonometric functions take and return degrees. That is the CAD convention —
// a sketch angle dimension reads 30, not 0.5236 — and it keeps `sin(a1)` correct
// when `a1` is an angle parameter, whose canonical unit is already degrees.
const DEGREES = Math.PI / 180;

type ParameterFunction = { arity: number | [number, number]; apply: (args: number[]) => number };

const FUNCTIONS: Record<string, ParameterFunction> = {
  sin: { arity: 1, apply: ([x]) => Math.sin(x * DEGREES) },
  cos: { arity: 1, apply: ([x]) => Math.cos(x * DEGREES) },
  tan: { arity: 1, apply: ([x]) => Math.tan(x * DEGREES) },
  asin: { arity: 1, apply: ([x]) => Math.asin(x) / DEGREES },
  acos: { arity: 1, apply: ([x]) => Math.acos(x) / DEGREES },
  atan: { arity: 1, apply: ([x]) => Math.atan(x) / DEGREES },
  atan2: { arity: 2, apply: ([y, x]) => Math.atan2(y, x) / DEGREES },
  sqrt: { arity: 1, apply: ([x]) => Math.sqrt(x) },
  abs: { arity: 1, apply: ([x]) => Math.abs(x) },
  sign: { arity: 1, apply: ([x]) => Math.sign(x) },
  floor: { arity: 1, apply: ([x]) => Math.floor(x) },
  ceil: { arity: 1, apply: ([x]) => Math.ceil(x) },
  round: { arity: 1, apply: ([x]) => Math.round(x) },
  pow: { arity: 2, apply: ([x, y]) => x ** y },
  log: { arity: 1, apply: ([x]) => Math.log(x) },
  log10: { arity: 1, apply: ([x]) => Math.log10(x) },
  exp: { arity: 1, apply: ([x]) => Math.exp(x) },
  min: { arity: [1, 16], apply: (args) => Math.min(...args) },
  max: { arity: [1, 16], apply: (args) => Math.max(...args) },
};

const RESERVED_NAMES = new Set<string>([
  ...Object.keys(FUNCTIONS),
  ...Object.keys(CONSTANTS),
  ...Object.keys(MILLIMETERS_PER_UNIT),
  ...Object.keys(DEGREES_PER_UNIT),
]);

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedParameterName(name: string) {
  return RESERVED_NAMES.has(name.toLowerCase());
}

/** Returns null when the name is usable, otherwise a human-readable reason. */
export function validateParameterName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Parameter name cannot be empty";
  if (!NAME_PATTERN.test(trimmed)) {
    return "Parameter names may only contain letters, digits and underscores, and cannot start with a digit";
  }
  if (isReservedParameterName(trimmed)) {
    return `"${trimmed}" is a reserved unit, constant or function name`;
  }
  return null;
}

type TokenType = "number" | "identifier" | "operator";
type Token = { type: TokenType; text: string; value?: number; position: number };

function isDigit(character: string) {
  return character >= "0" && character <= "9";
}

function isIdentifierStart(character: string) {
  return /[A-Za-z_°'"]/.test(character);
}

function isIdentifierPart(character: string) {
  return /[A-Za-z0-9_]/.test(character);
}

function tokenize(expression: string, commaIsDecimalSeparator: boolean): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const character = expression[index];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (isDigit(character) || ((character === "." || (character === "," && commaIsDecimalSeparator)) && isDigit(expression[index + 1] ?? ""))) {
      const start = index;
      while (index < expression.length && isDigit(expression[index])) index += 1;
      const decimalPoint = commaIsDecimalSeparator ? /[.,]/ : /\./;
      if (index < expression.length && decimalPoint.test(expression[index])) {
        index += 1;
        while (index < expression.length && isDigit(expression[index])) index += 1;
      }
      // Scientific notation, but only when an exponent digit actually follows —
      // otherwise the `e` belongs to an identifier such as `edge_gap`.
      if (/[eE]/.test(expression[index] ?? "")) {
        const exponentStart = index;
        let lookahead = index + 1;
        if (/[+-]/.test(expression[lookahead] ?? "")) lookahead += 1;
        if (isDigit(expression[lookahead] ?? "")) {
          lookahead += 1;
          while (lookahead < expression.length && isDigit(expression[lookahead])) lookahead += 1;
          index = lookahead;
        } else {
          index = exponentStart;
        }
      }
      const text = expression.slice(start, index).replace(",", ".");
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new ParameterExpressionError(`"${text}" is not a valid number`, start);
      }
      tokens.push({ type: "number", text, value, position: start });
    } else if (isIdentifierStart(character)) {
      const start = index;
      // The bare unit symbols °, ' and " are single-character identifiers; every
      // other identifier continues with letters, digits or underscores.
      if (/[°'"]/.test(character)) {
        index += 1;
      } else {
        while (index < expression.length && isIdentifierPart(expression[index])) index += 1;
      }
      tokens.push({ type: "identifier", text: expression.slice(start, index), position: start });
    } else if ("+-*/^%(),".includes(character)) {
      tokens.push({ type: "operator", text: character, position: index });
      index += 1;
    } else {
      throw new ParameterExpressionError(`Unexpected character "${character}"`, index);
    }

    if (tokens.length > MAX_TOKENS) {
      throw new ParameterExpressionError("Expression is too complex");
    }
  }

  return tokens;
}

function unitFactor(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower in MILLIMETERS_PER_UNIT) return MILLIMETERS_PER_UNIT[lower];
  if (name in DEGREES_PER_UNIT) return DEGREES_PER_UNIT[name];
  if (lower in DEGREES_PER_UNIT) return DEGREES_PER_UNIT[lower];
  return null;
}

class Parser {
  private position = 0;
  private depth = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly scope: ReadonlyMap<string, number>,
  ) {}

  parse(): number {
    const value = this.additive();
    const leftover = this.peek();
    if (leftover) {
      throw new ParameterExpressionError(`Unexpected "${leftover.text}"`, leftover.position);
    }
    return value;
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  private consumeOperator(...candidates: string[]): Token | undefined {
    const token = this.peek();
    if (token?.type === "operator" && candidates.includes(token.text)) {
      this.position += 1;
      return token;
    }
    return undefined;
  }

  private enter() {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw new ParameterExpressionError("Expression is nested too deeply");
    }
  }

  private leave() {
    this.depth -= 1;
  }

  private additive(): number {
    let value = this.multiplicative();
    for (;;) {
      const operator = this.consumeOperator("+", "-");
      if (!operator) return value;
      const right = this.multiplicative();
      value = operator.text === "+" ? value + right : value - right;
    }
  }

  private multiplicative(): number {
    let value = this.unary();
    for (;;) {
      const operator = this.consumeOperator("*", "/", "%");
      if (!operator) return value;
      const right = this.unary();
      if ((operator.text === "/" || operator.text === "%") && right === 0) {
        throw new ParameterExpressionError("Division by zero", operator.position);
      }
      value = operator.text === "*" ? value * right : operator.text === "/" ? value / right : value % right;
    }
  }

  private unary(): number {
    const operator = this.consumeOperator("+", "-");
    if (operator) {
      this.enter();
      try {
        const value = this.unary();
        return operator.text === "-" ? -value : value;
      } finally {
        this.leave();
      }
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    // Right-associative, and the exponent goes through `unary` so `2^-1` parses.
    if (this.consumeOperator("^")) {
      this.enter();
      try {
        return base ** this.unary();
      } finally {
        this.leave();
      }
    }
    return base;
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new ParameterExpressionError("Expression ended unexpectedly");

    if (token.type === "number") {
      this.position += 1;
      let value = token.value ?? Number.NaN;
      // A unit suffix directly after the literal scales it into the canonical
      // unit. `2mm(...)` is not a unit — an identifier followed by `(` is a call.
      const next = this.peek();
      if (next?.type === "identifier" && this.peek(1)?.text !== "(") {
        const factor = unitFactor(next.text);
        if (factor !== null) {
          this.position += 1;
          value *= factor;
        }
      }
      return value;
    }

    if (token.type === "identifier") {
      this.position += 1;
      const name = token.text;

      if (this.peek()?.type === "operator" && this.peek()?.text === "(") {
        const fn = FUNCTIONS[name.toLowerCase()];
        if (!fn) throw new ParameterExpressionError(`Unknown function "${name}"`, token.position);
        this.position += 1;
        const args: number[] = [];
        if (!(this.peek()?.type === "operator" && this.peek()?.text === ")")) {
          this.enter();
          try {
            for (;;) {
              args.push(this.additive());
              if (!this.consumeOperator(",")) break;
            }
          } finally {
            this.leave();
          }
        }
        if (!this.consumeOperator(")")) {
          throw new ParameterExpressionError(`Missing ")" after "${name}("`, token.position);
        }
        const [minArity, maxArity] = Array.isArray(fn.arity) ? fn.arity : [fn.arity, fn.arity];
        if (args.length < minArity || args.length > maxArity) {
          const expected = minArity === maxArity ? `${minArity}` : `${minArity} to ${maxArity}`;
          throw new ParameterExpressionError(`"${name}" expects ${expected} argument(s), got ${args.length}`, token.position);
        }
        const result = fn.apply(args);
        if (!Number.isFinite(result)) {
          throw new ParameterExpressionError(`"${name}" is not defined for those values`, token.position);
        }
        return result;
      }

      const constant = CONSTANTS[name.toLowerCase()];
      if (constant !== undefined) return constant;

      const referenced = this.scope.get(name);
      if (referenced !== undefined) return referenced;

      throw new ParameterExpressionError(`Unknown parameter "${name}"`, token.position);
    }

    if (token.text === "(") {
      this.position += 1;
      this.enter();
      try {
        const value = this.additive();
        if (!this.consumeOperator(")")) {
          throw new ParameterExpressionError('Missing ")"', token.position);
        }
        return value;
      } finally {
        this.leave();
      }
    }

    throw new ParameterExpressionError(`Unexpected "${token.text}"`, token.position);
  }
}

/**
 * Evaluates a single expression against a scope of already-resolved parameters.
 *
 * Comma handling: when the expression contains no `(` a comma cannot be an
 * argument separator, so it is read as a decimal separator — `12,5` keeps
 * working for users on a German keyboard. As soon as a call is present, commas
 * separate arguments and `.` is the decimal point.
 *
 * @throws {ParameterExpressionError} when the expression is malformed.
 */
export function evaluateExpression(expression: string, scope: ReadonlyMap<string, number> = new Map()): number {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ParameterExpressionError("Expression is too long");
  }
  const trimmed = expression.trim();
  if (!trimmed) throw new ParameterExpressionError("Expression is empty");

  const tokens = tokenize(trimmed, !trimmed.includes("("));
  if (tokens.length === 0) throw new ParameterExpressionError("Expression is empty");

  const value = new Parser(tokens, scope).parse();
  if (!Number.isFinite(value)) {
    throw new ParameterExpressionError("Expression does not evaluate to a finite number");
  }
  return value;
}

/** Names this expression reads, so the table resolver can order and cycle-check. */
export function expressionDependencies(expression: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenize(expression.trim(), !expression.includes("("));
  } catch {
    return [];
  }
  const names = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.type !== "identifier") return;
    // Skip call targets, constants, and unit suffixes attached to a literal.
    if (tokens[index + 1]?.text === "(") return;
    if (CONSTANTS[token.text.toLowerCase()] !== undefined) return;
    if (tokens[index - 1]?.type === "number" && unitFactor(token.text) !== null) return;
    names.add(token.text);
  });
  return [...names];
}

/**
 * Resolves a whole parameter table in dependency order.
 *
 * Parameters that reference an unknown name, fail to evaluate, or take part in a
 * reference cycle are reported in `errors` and left out of `values`; every other
 * parameter still resolves, so one broken row never blanks the entire table.
 */
export function evaluateParameterTable(parameters: readonly SketchParameter[]): ParameterTableResult {
  const byName = new Map<string, SketchParameter>();
  const errors = new Map<string, string>();
  const values = new Map<string, number>();

  parameters.forEach((parameter) => {
    const nameError = validateParameterName(parameter.name);
    if (nameError) {
      errors.set(parameter.id, nameError);
      return;
    }
    if (byName.has(parameter.name)) {
      errors.set(parameter.id, `Duplicate parameter name "${parameter.name}"`);
      return;
    }
    byName.set(parameter.name, parameter);
  });

  // Iterative depth-first resolution. `visiting` detects cycles; `failed` stops a
  // broken parameter from being retried once per dependent.
  const visiting = new Set<string>();
  const failed = new Set<string>();

  const resolve = (name: string, trail: string[]): boolean => {
    if (values.has(name)) return true;
    if (failed.has(name)) return false;

    const parameter = byName.get(name);
    if (!parameter) return false;

    if (visiting.has(name)) {
      const cycle = [...trail.slice(trail.indexOf(name)), name].join(" → ");
      errors.set(parameter.id, `Parameter cycle: ${cycle}`);
      failed.add(name);
      return false;
    }

    visiting.add(name);
    try {
      for (const dependency of expressionDependencies(parameter.expression)) {
        if (!byName.has(dependency)) continue; // Reported by evaluateExpression below.
        if (!resolve(dependency, [...trail, name])) {
          if (!errors.has(parameter.id)) {
            errors.set(parameter.id, `Depends on "${dependency}", which could not be resolved`);
          }
          failed.add(name);
          return false;
        }
      }
      const value = evaluateExpression(parameter.expression, values);
      values.set(name, value);
      return true;
    } catch (error) {
      errors.set(parameter.id, error instanceof Error ? error.message : String(error));
      failed.add(name);
      return false;
    } finally {
      visiting.delete(name);
    }
  };

  byName.forEach((_parameter, name) => {
    resolve(name, []);
  });

  const resolved = parameters
    .filter((parameter) => values.has(parameter.name) && !errors.has(parameter.id))
    .map((parameter) => ({ ...parameter, value: values.get(parameter.name) as number }));

  return { parameters: resolved, values, errors };
}

/**
 * A dimension either holds a literal number or drives off a named expression.
 * Storing the expression alongside the last solved value lets the sketch render
 * immediately after load, before the parameter table has been evaluated.
 */
export type ParameterValue = { expression: string; value: number };

export function parameterValue(expression: string, scope: ReadonlyMap<string, number>, fallback: number): ParameterValue {
  try {
    return { expression, value: evaluateExpression(expression, scope) };
  } catch {
    return { expression, value: fallback };
  }
}
