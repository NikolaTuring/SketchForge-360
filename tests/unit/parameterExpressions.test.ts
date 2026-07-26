import { describe, expect, it } from "vitest";
import {
  ParameterExpressionError,
  evaluateExpression,
  evaluateParameterTable,
  expressionDependencies,
  isReservedParameterName,
  validateParameterName,
  type SketchParameter,
} from "@/lib/parameterExpressions";

function scope(entries: Record<string, number>) {
  return new Map(Object.entries(entries));
}

function parameter(id: string, name: string, expression: string, unit: SketchParameter["unit"] = "length"): SketchParameter {
  return { id, name, expression, unit };
}

describe("evaluateExpression", () => {
  it("evaluates arithmetic with the usual precedence", () => {
    expect(evaluateExpression("2 + 3 * 4")).toBe(14);
    expect(evaluateExpression("(2 + 3) * 4")).toBe(20);
    expect(evaluateExpression("10 / 4")).toBe(2.5);
    expect(evaluateExpression("10 % 4")).toBe(2);
  });

  it("treats ^ as right-associative and binds tighter than unary minus", () => {
    expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluateExpression("-2 ^ 2")).toBe(-4);
    expect(evaluateExpression("2 ^ -1")).toBe(0.5);
  });

  it("converts length unit suffixes to millimetres", () => {
    expect(evaluateExpression("1cm")).toBe(10);
    expect(evaluateExpression("25mm + 1cm")).toBe(35);
    expect(evaluateExpression("1in")).toBeCloseTo(25.4, 10);
    expect(evaluateExpression("1 ft")).toBeCloseTo(304.8, 10);
    expect(evaluateExpression("2m")).toBe(2000);
  });

  it("converts angle unit suffixes to degrees", () => {
    expect(evaluateExpression("90deg")).toBe(90);
    expect(evaluateExpression("1rad")).toBeCloseTo(180 / Math.PI, 10);
    expect(evaluateExpression("0.25turn")).toBe(90);
    expect(evaluateExpression("45°")).toBe(45);
  });

  it("evaluates trigonometry in degrees", () => {
    expect(evaluateExpression("sin(30)")).toBeCloseTo(0.5, 12);
    expect(evaluateExpression("sin(30deg)")).toBeCloseTo(0.5, 12);
    expect(evaluateExpression("cos(60)")).toBeCloseTo(0.5, 12);
    expect(evaluateExpression("asin(0.5)")).toBeCloseTo(30, 12);
    expect(evaluateExpression("atan2(1, 1)")).toBeCloseTo(45, 12);
  });

  it("supports the remaining function set and constants", () => {
    expect(evaluateExpression("sqrt(16)")).toBe(4);
    expect(evaluateExpression("abs(0 - 3)")).toBe(3);
    expect(evaluateExpression("min(4, 2, 9)")).toBe(2);
    expect(evaluateExpression("max(4, 2, 9)")).toBe(9);
    expect(evaluateExpression("round(2.6)")).toBe(3);
    expect(evaluateExpression("pow(2, 10)")).toBe(1024);
    expect(evaluateExpression("pi")).toBeCloseTo(Math.PI, 12);
  });

  it("resolves references from the scope", () => {
    expect(evaluateExpression("width * 2", scope({ width: 12 }))).toBe(24);
    expect(evaluateExpression("wall_thickness + 1", scope({ wall_thickness: 2 }))).toBe(3);
  });

  it("reads a comma as a decimal separator when there is no call", () => {
    expect(evaluateExpression("12,5")).toBe(12.5);
    expect(evaluateExpression("12,5 * 2")).toBe(25);
  });

  it("reads a comma as an argument separator once a call is present", () => {
    expect(evaluateExpression("max(1, 2)")).toBe(2);
  });

  it("parses scientific notation without swallowing identifiers that start with e", () => {
    expect(evaluateExpression("1e3")).toBe(1000);
    expect(evaluateExpression("2e-2")).toBeCloseTo(0.02, 12);
    expect(evaluateExpression("2 * edge_gap", scope({ edge_gap: 5 }))).toBe(10);
  });

  it("rejects malformed and unsafe input", () => {
    expect(() => evaluateExpression("")).toThrow(ParameterExpressionError);
    expect(() => evaluateExpression("2 +")).toThrow(ParameterExpressionError);
    expect(() => evaluateExpression("(2 + 3")).toThrow(/Missing/);
    expect(() => evaluateExpression("2 3")).toThrow(/Unexpected/);
    expect(() => evaluateExpression("width")).toThrow(/Unknown parameter "width"/);
    expect(() => evaluateExpression("nope(2)")).toThrow(/Unknown function "nope"/);
    expect(() => evaluateExpression("sqrt(1, 2)")).toThrow(/expects 1 argument/);
    expect(() => evaluateExpression("1 / 0")).toThrow(/Division by zero/);
    expect(() => evaluateExpression("sqrt(0 - 1)")).toThrow(/not defined/);
    expect(() => evaluateExpression("process.exit(1)")).toThrow(ParameterExpressionError);
    expect(() => evaluateExpression("globalThis")).toThrow(/Unknown parameter/);
    expect(() => evaluateExpression("2 $ 3")).toThrow(/Unexpected character/);
    expect(() => evaluateExpression("1".padEnd(2500, "+1"))).toThrow(/too long/);
    expect(() => evaluateExpression(`${"(".repeat(80)}1${")".repeat(80)}`)).toThrow(/nested too deeply/);
  });
});

describe("expressionDependencies", () => {
  it("reports referenced parameter names only", () => {
    expect(expressionDependencies("width * 2 + height").sort()).toEqual(["height", "width"]);
  });

  it("ignores functions, constants and unit suffixes", () => {
    expect(expressionDependencies("sin(30deg) * pi + 2mm")).toEqual([]);
  });

  it("does not mistake a unit name used as a bare reference for a suffix", () => {
    expect(expressionDependencies("m + 1")).toEqual(["m"]);
  });
});

describe("validateParameterName", () => {
  it("accepts ordinary identifiers", () => {
    expect(validateParameterName("wall_thickness")).toBeNull();
    expect(validateParameterName("d1")).toBeNull();
  });

  it("rejects empty, malformed and reserved names", () => {
    expect(validateParameterName("")).toMatch(/empty/);
    expect(validateParameterName("2d")).toMatch(/cannot start with a digit/);
    expect(validateParameterName("wall thickness")).toMatch(/only contain/);
    expect(validateParameterName("mm")).toMatch(/reserved/);
    expect(validateParameterName("sin")).toMatch(/reserved/);
    expect(isReservedParameterName("PI")).toBe(true);
  });
});

describe("evaluateParameterTable", () => {
  it("resolves parameters in dependency order regardless of input order", () => {
    const result = evaluateParameterTable([
      parameter("3", "total", "inner + wall * 2"),
      parameter("1", "wall", "2mm"),
      parameter("2", "inner", "wall * 10"),
    ]);

    expect(result.errors.size).toBe(0);
    expect(result.values.get("wall")).toBe(2);
    expect(result.values.get("inner")).toBe(20);
    expect(result.values.get("total")).toBe(24);
    expect(result.parameters.map((entry) => entry.name)).toEqual(["total", "wall", "inner"]);
  });

  it("reports reference cycles without resolving the cycle members", () => {
    const result = evaluateParameterTable([
      parameter("1", "a", "b + 1"),
      parameter("2", "b", "a + 1"),
    ]);

    expect(result.values.has("a")).toBe(false);
    expect(result.values.has("b")).toBe(false);
    expect([...result.errors.values()].some((message) => /cycle/i.test(message))).toBe(true);
  });

  it("detects a parameter that references itself", () => {
    const result = evaluateParameterTable([parameter("1", "a", "a * 2")]);
    expect(result.errors.get("1")).toMatch(/cycle/i);
  });

  it("keeps healthy parameters when one row is broken", () => {
    const result = evaluateParameterTable([
      parameter("1", "good", "5mm"),
      parameter("2", "broken", "1 / 0"),
      parameter("3", "dependent", "broken + 1"),
      parameter("4", "other", "good * 3"),
    ]);

    expect(result.values.get("good")).toBe(5);
    expect(result.values.get("other")).toBe(15);
    expect(result.errors.get("2")).toMatch(/Division by zero/);
    expect(result.errors.get("3")).toMatch(/could not be resolved/);
  });

  it("rejects duplicate and invalid names", () => {
    const result = evaluateParameterTable([
      parameter("1", "a", "1"),
      parameter("2", "a", "2"),
      parameter("3", "mm", "3"),
    ]);

    expect(result.errors.get("2")).toMatch(/Duplicate/);
    expect(result.errors.get("3")).toMatch(/reserved/);
  });
});
