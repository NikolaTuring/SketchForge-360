"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ParametersDialog } from "@/components/sketch/ParametersDialog";
import { entitiesBounds, entityHandles, entityMidpoint, entityPath } from "@/components/sketch/sketchRender";
import { evaluateExpression, evaluateParameterTable, type SketchParameter } from "@/lib/parameterExpressions";
import { distanceVec2, pointRef, vec2 } from "@/lib/sketchEntities";
import {
  circularPattern,
  distanceToEntity,
  extendEntity,
  filletLines,
  mirrorEntities,
  offsetEntities,
  rectangularPattern,
  trimEntity,
} from "@/lib/sketchEditing";
import {
  DRAW_TOOLS,
  MODIFY_TOOLS,
  clickDrawTool,
  draftPreview,
  isDrawTool,
  isModifyTool,
  pruneConstraints,
  snapCandidates,
  snapPoint,
  type SketchDraft,
  type SketchTool,
} from "@/lib/sketchSession";
import { solveSketch } from "@/lib/sketchSolver";
import { useTranslation, type TranslationKey } from "@/lib/i18n";
import type { Sketch, SketchConstraint, SketchEntity, SketchEntityId, Vec2 } from "@/types/sketch";

/**
 * The parametric sketcher.
 *
 * Draw, constrain, dimension, solve — the loop the whole feature exists for.
 * Sketch units are SVG units and pan/zoom live in the `viewBox`, so a 25 mm line
 * is 25 units of markup and nothing has to be un-transformed to read a
 * coordinate back.
 *
 * The sketch is re-solved after every change. That is affordable because the
 * solver works on the entities alone, and it is the only way the colouring can
 * be truthful: geometry that is fully constrained looks different from geometry
 * that is still free, and a stale answer there is worse than none.
 */

const GEOMETRIC_CONSTRAINTS = [
  { type: "coincident", labelKey: "constraint.coincident", arity: "points" },
  { type: "horizontal", labelKey: "constraint.horizontal", arity: "entity" },
  { type: "vertical", labelKey: "constraint.vertical", arity: "entity" },
  { type: "parallel", labelKey: "constraint.parallel", arity: "entities2" },
  { type: "perpendicular", labelKey: "constraint.perpendicular", arity: "entities2" },
  { type: "equal", labelKey: "constraint.equal", arity: "entities2" },
  { type: "tangent", labelKey: "constraint.tangent", arity: "entities2" },
  { type: "concentric", labelKey: "constraint.concentric", arity: "entities2" },
] as const;

const DIMENSION_KINDS = [
  { type: "distance", labelKey: "dimension.distance" },
  { type: "horizontalDistance", labelKey: "dimension.horizontal" },
  { type: "verticalDistance", labelKey: "dimension.vertical" },
  { type: "radius", labelKey: "dimension.radius" },
  { type: "diameter", labelKey: "dimension.diameter" },
  { type: "angle", labelKey: "dimension.angle" },
] as const;

export type ParametricSketchEditorProps = {
  initial: Sketch;
  /** The distance is part of finishing, so the button says what it will build. */
  onFinish: (sketch: Sketch, extrudeDistance: number) => void;
  busy?: boolean;
  onCancel: () => void;
  /** Reported so the editor can show it in the status bar. */
  onDegreesOfFreedomChange?: (dof: number) => void;
};

type PickTarget = { kind: "entity"; id: SketchEntityId } | { kind: "point"; ref: { entityId: string; role: string } };

export function ParametricSketchEditor({
  initial,
  onFinish,
  onCancel,
  onDegreesOfFreedomChange,
  busy = false,
}: ParametricSketchEditorProps) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const idCounter = useRef(0);

  const [entities, setEntities] = useState<SketchEntity[]>(initial.entities);
  const [constraints, setConstraints] = useState<SketchConstraint[]>(initial.constraints);
  const [tool, setTool] = useState<SketchTool>("select");
  const [draft, setDraft] = useState<SketchDraft | null>(null);
  const [cursor, setCursor] = useState<Vec2>(vec2(0, 0));
  const [selection, setSelection] = useState<PickTarget[]>([]);
  const [construction, setConstruction] = useState(false);
  const [polygonSides, setPolygonSides] = useState(6);
  const [snapStep, setSnapStep] = useState(1);
  const [view, setView] = useState({ x: -60, y: -60, size: 160 });
  const [dimensionDraft, setDimensionDraft] = useState<{ type: string; expression: string } | null>(null);
  const [message, setMessage] = useState<string>("");
  /*
   * Tool options, the way a CAD tool carries them: set the number first, then
   * click. A modal prompt on every click would break the rhythm of trimming
   * twenty corners, and it cannot be reached from the keyboard at all.
   */
  const [offsetDistance, setOffsetDistance] = useState(2);
  const [filletRadius, setFilletRadius] = useState(2);
  const [patternCount, setPatternCount] = useState(3);
  const [patternSpacing, setPatternSpacing] = useState(20);
  const [extrudeDistance, setExtrudeDistance] = useState(10);
  const [parameters, setParameters] = useState<SketchParameter[]>(initial.parameters ?? []);
  const [parametersOpen, setParametersOpen] = useState(false);

  const nextId = useCallback(() => {
    idCounter.current += 1;
    return `sk-${idCounter.current}`;
  }, []);

  // Ids continue past anything the incoming sketch already used, so a reopened
  // sketch cannot mint an id that collides with one of its own.
  useEffect(() => {
    const highest = initial.entities
      .concat()
      .map((entity) => Number.parseInt(entity.id.replace(/^sk-/, ""), 10))
      .filter((value) => Number.isFinite(value));
    idCounter.current = Math.max(0, ...highest);
  }, [initial]);

  const sketch = useMemo<Sketch>(
    () => ({ ...initial, entities, constraints, ...(parameters.length ? { parameters } : {}) }),
    [constraints, entities, initial, parameters],
  );

  /*
   * Parameter values, resolved in dependency order.
   *
   * A row that cannot be evaluated is simply absent from the scope rather than
   * contributing a zero, so a dimension that depends on it reports "unknown
   * name" — which points at the broken parameter instead of silently
   * collapsing the geometry.
   */
  const parameterScope = useMemo(() => evaluateParameterTable(parameters).values, [parameters]);

  const solved = useMemo(
    () => solveSketch(sketch, { parameterScope }),
    [parameterScope, sketch],
  );

  useEffect(() => {
    onDegreesOfFreedomChange?.(solved.degreesOfFreedom);
  }, [onDegreesOfFreedomChange, solved.degreesOfFreedom]);

  // The solved entities are what is drawn: showing the unsolved ones would mean
  // a dimension typed in does not move anything until some later redraw.
  const display = solved.entities;

  const unitsPerPixel = useMemo(() => {
    const box = svgRef.current?.getBoundingClientRect();
    return view.size / Math.max(1, box?.width ?? 800);
  }, [view.size]);

  /** Screen coordinates to sketch coordinates, through the SVG's own matrix. */
  const toSketch = useCallback((clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current;
    if (!svg) return vec2(0, 0);
    const matrix = svg.getScreenCTM();
    if (!matrix) return vec2(0, 0);
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const mapped = point.matrixTransform(matrix.inverse());
    // Screen y grows downward, sketch v grows upward.
    return vec2(mapped.x, -mapped.y);
  }, []);

  /** The point a click lands on: a snap candidate if one is near, else the grid. */
  const resolvePoint = useCallback(
    (raw: Vec2): Vec2 => {
      const radius = unitsPerPixel * 10;
      const [nearest] = snapCandidates(display, raw, radius);
      return nearest ? nearest.point : snapPoint(raw, snapStep);
    },
    [display, snapStep, unitsPerPixel],
  );

  const pickEntity = useCallback(
    (at: Vec2): SketchEntity | null => {
      const radius = unitsPerPixel * 8;
      let best: SketchEntity | null = null;
      let bestDistance = radius;
      display.forEach((entity) => {
        const distance = distanceToEntity(entity, at);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = entity;
        }
      });
      return best;
    },
    [display, unitsPerPixel],
  );

  const commit = useCallback(
    (nextEntities: SketchEntity[], nextConstraints?: SketchConstraint[]) => {
      const pruned = pruneConstraints(nextConstraints ?? constraints, nextEntities);
      setEntities(nextEntities);
      setConstraints(pruned);
    },
    [constraints],
  );

  const applyModifyTool = useCallback(
    (modify: string, at: Vec2) => {
      const target = pickEntity(at);
      if (!target) {
        setMessage(t("sketch.pickGeometry"));
        return;
      }

      if (modify === "trim") {
        const result = trimEntity(entities, target.id, at, nextId);
        commit(result.entities);
        return;
      }
      if (modify === "extend") {
        const result = extendEntity(entities, target.id, at, nextId);
        commit(result.entities);
        return;
      }
      if (modify === "offset") {
        const created = offsetEntities([target], offsetDistance, nextId);
        if (created.length === 0) {
          // A circle offset past its own centre has no geometry left; saying so
          // beats a click that silently does nothing.
          setMessage(t("sketch.offsetTooFar"));
          return;
        }
        commit([...entities, ...created]);
        return;
      }
      if (modify === "fillet") {
        // Two picks: the first is remembered in the selection.
        const [previous] = selection;
        if (!previous || previous.kind !== "entity" || previous.id === target.id) {
          setSelection([{ kind: "entity", id: target.id }]);
          setMessage(t("sketch.pickSecondLine"));
          return;
        }
        const result = filletLines(entities, previous.id, target.id, filletRadius, nextId);
        if (!result.arcId) {
          // Refused rather than clamped, so say so instead of doing nothing.
          setMessage(t("sketch.filletDoesNotFit"));
          return;
        }
        commit(result.entities);
        setSelection([]);
        return;
      }
      if (modify === "mirror") {
        const [axis] = selection;
        if (!axis || axis.kind !== "entity") {
          setSelection([{ kind: "entity", id: target.id }]);
          setMessage(t("sketch.pickMirrorAxis"));
          return;
        }
        const axisEntity = entities.find((entity) => entity.id === axis.id);
        if (!axisEntity || axisEntity.type !== "line") {
          setMessage(t("sketch.mirrorNeedsLine"));
          return;
        }
        commit([...entities, ...mirrorEntities([target], axisEntity.a, axisEntity.b, nextId)]);
        setSelection([]);
      }
    },
    [commit, entities, filletRadius, nextId, offsetDistance, pickEntity, selection, t],
  );

  const handleClick = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.button !== 0) return;
      const raw = toSketch(event.clientX, event.clientY);

      if (isDrawTool(tool)) {
        const point = resolvePoint(raw);
        const result = clickDrawTool(tool, draft, point, nextId, { polygonSides, construction });
        setDraft(result.draft);
        if (result.geometry) {
          setEntities((current) => [...current, ...result.geometry!.entities]);
          setConstraints((current) => [...current, ...result.geometry!.constraints]);
        }
        return;
      }

      if (isModifyTool(tool)) {
        applyModifyTool(tool, raw);
        return;
      }

      // Select. Shift adds to the selection, which is what the constraint
      // palette needs — most constraints take two things.
      const hit = pickEntity(raw);
      const additive = event.shiftKey;
      if (!hit) {
        if (!additive) setSelection([]);
        return;
      }
      const entry: PickTarget = { kind: "entity", id: hit.id };
      setSelection((current) => {
        if (!additive) return [entry];
        return current.some((item) => item.kind === "entity" && item.id === hit.id)
          ? current.filter((item) => !(item.kind === "entity" && item.id === hit.id))
          : [...current, entry];
      });
    },
    [applyModifyTool, construction, draft, nextId, pickEntity, polygonSides, resolvePoint, tool, toSketch],
  );

  const selectedEntityIds = useMemo(
    () => selection.filter((item) => item.kind === "entity").map((item) => (item as { id: string }).id),
    [selection],
  );

  const addConstraint = useCallback(
    (type: string, arity: string) => {
      const ids = selectedEntityIds;
      let constraint: SketchConstraint | null = null;

      if (arity === "entity" && ids.length >= 1) {
        constraint = { id: nextId(), type, entity: ids[0] } as SketchConstraint;
      } else if (arity === "entities2" && ids.length >= 2) {
        constraint = { id: nextId(), type, a: ids[0], b: ids[1] } as SketchConstraint;
      } else if (arity === "points" && ids.length >= 2) {
        // Join the two nearest endpoints of the two entities, which is what a
        // user picking two lines and asking for coincidence means.
        const first = entities.find((entity) => entity.id === ids[0]);
        const second = entities.find((entity) => entity.id === ids[1]);
        const pair = nearestEndpointPair(first, second);
        if (pair) constraint = { id: nextId(), type: "coincident", a: pair.a, b: pair.b };
      }

      if (!constraint) {
        setMessage(t("sketch.selectMoreForConstraint"));
        return;
      }
      setConstraints((current) => [...current, constraint!]);
      setMessage("");
    },
    [entities, nextId, selectedEntityIds, t],
  );

  const addDimension = useCallback(
    (type: string, expression: string) => {
      let value: number;
      try {
        value = evaluateExpression(expression, parameterScope);
      } catch (error) {
        // The parser's own message names the offending token, which is far more
        // use than "invalid expression".
        setMessage(error instanceof Error ? error.message : t("sketch.selectForDimension"));
        return false;
      }
      const ids = selectedEntityIds;
      const dimension = { expression, value };
      let constraint: SketchConstraint | null = null;

      if ((type === "radius" || type === "diameter") && ids.length >= 1) {
        constraint = { id: nextId(), type, entity: ids[0], value: dimension } as SketchConstraint;
      } else if (type === "angle" && ids.length >= 2) {
        constraint = { id: nextId(), type: "angle", a: ids[0], b: ids[1], value: dimension };
      } else if (ids.length >= 1) {
        const entity = entities.find((item) => item.id === ids[0]);
        if (entity?.type === "line") {
          constraint = {
            id: nextId(),
            type,
            a: pointRef(entity.id, "start"),
            b: pointRef(entity.id, "end"),
            value: dimension,
          } as SketchConstraint;
        }
      }

      if (!constraint) {
        setMessage(t("sketch.selectForDimension"));
        return false;
      }
      setConstraints((current) => [...current, constraint!]);
      setMessage("");
      return true;
    },
    [entities, nextId, parameterScope, selectedEntityIds, t],
  );

  const applyPattern = useCallback(
    (kind: "rectangular" | "circular") => {
      const chosen = entities.filter((entity) => selectedEntityIds.includes(entity.id));
      if (chosen.length === 0) {
        setMessage(t("sketch.selectToPattern"));
        return;
      }
      const copies = kind === "rectangular"
        ? rectangularPattern(chosen, { step: vec2(patternSpacing, 0), count: patternCount }, nextId)
        // The centre is the sketch origin: a circular pattern needs a point to
        // turn about, and the origin is the one the user can always see.
        : circularPattern(chosen, { center: vec2(0, 0), count: patternCount }, nextId);
      if (copies.length === 0) {
        setMessage(t("sketch.selectToPattern"));
        return;
      }
      commit([...entities, ...copies]);
      setMessage("");
    },
    [commit, entities, nextId, patternCount, patternSpacing, selectedEntityIds, t],
  );

  const deleteSelection = useCallback(() => {
    if (selectedEntityIds.length === 0) return;
    const doomed = new Set(selectedEntityIds);
    commit(entities.filter((entity) => !doomed.has(entity.id)));
    setSelection([]);
  }, [commit, entities, selectedEntityIds]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Escape backs out one step at a time: the shape being drawn, then the
        // tool, then the selection. Jumping straight out of the sketch would
        // throw away work over one keypress.
        if (draft) setDraft(null);
        else if (tool !== "select") setTool("select");
        else if (selection.length > 0) setSelection([]);
        else onCancel();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [deleteSelection, draft, onCancel, selection.length, tool]);

  const preview = draftPreview(draft, resolvePoint(cursor), { polygonSides, construction });
  const stroke = unitsPerPixel * 1.4;
  const handleRadius = unitsPerPixel * 3.2;

  const zoom = (factor: number) =>
    setView((current) => {
      const size = Math.max(2, Math.min(4000, current.size * factor));
      const center = { x: current.x + current.size / 2, y: current.y + current.size / 2 };
      return { x: center.x - size / 2, y: center.y - size / 2, size };
    });

  const fit = () => {
    const bounds = entitiesBounds(display);
    if (!bounds) return;
    const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, 10) * 1.3;
    setView({ x: (bounds.min.x + bounds.max.x) / 2 - span / 2, y: -(bounds.min.y + bounds.max.y) / 2 - span / 2, size: span });
  };

  const constraintCount = constraints.length;

  return (
    <div className="parametric-sketch" data-testid="parametric-sketch">
      <div className="sketch-rail" role="toolbar" aria-label={t("sketch.tools")}>
        <ToolButton id="select" active={tool === "select"} onSelect={setTool} label={t("sketch.tool.select")} />
        {DRAW_TOOLS.map((entry) => (
          <ToolButton
            key={entry}
            id={entry}
            active={tool === entry}
            onSelect={(next) => {
              setTool(next);
              setDraft(null);
            }}
            label={t(`sketch.tool.${entry}` as TranslationKey)}
          />
        ))}
        <div className="sketch-rail-divider" />
        {MODIFY_TOOLS.map((entry) => (
          <ToolButton
            key={entry}
            id={entry}
            active={tool === entry}
            onSelect={(next) => {
              setTool(next);
              setSelection([]);
            }}
            label={t(`sketch.tool.${entry}` as TranslationKey)}
          />
        ))}
      </div>

      <svg
        ref={svgRef}
        className="sketch-canvas"
        data-testid="sketch-canvas"
        viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`}
        onPointerDown={handleClick}
        onPointerMove={(event) => setCursor(toSketch(event.clientX, event.clientY))}
        role="application"
        aria-label={t("sketch.canvas")}
      >
        {/* The plane's own axes, so "where is the origin" is never a guess. */}
        <g className="sketch-axes" strokeWidth={stroke * 0.7}>
          <line x1={view.x} y1={0} x2={view.x + view.size} y2={0} />
          <line x1={0} y1={view.y} x2={0} y2={view.y + view.size} />
        </g>

        {/* Sketch v grows upward; SVG y grows down. One flip here keeps every
            coordinate in the markup readable as a sketch coordinate. */}
        <g transform="scale(1, -1)">
          {display.map((entity) => {
            const path = entityPath(entity);
            if (!path) return null;
            const selected = selectedEntityIds.includes(entity.id);
            return (
              <path
                key={entity.id}
                className={`sketch-entity ${entity.construction ? "construction" : ""} ${selected ? "selected" : ""}`}
                data-testid={`sketch-entity-${entity.id}`}
                data-entity-type={entity.type}
                d={path}
                strokeWidth={stroke}
              />
            );
          })}

          {preview.map((entity) => {
            const path = entityPath(entity);
            return path ? <path key={entity.id} className="sketch-preview" d={path} strokeWidth={stroke} /> : null;
          })}

          {display.flatMap((entity) =>
            entityHandles(entity).map((handle) => (
              <circle
                key={`${entity.id}-${handle.role}`}
                className="sketch-handle"
                cx={handle.point.x}
                cy={handle.point.y}
                r={handleRadius}
              />
            )),
          )}

          {constraints
            .filter((constraint) => "value" in constraint)
            .map((constraint) => {
              const record = constraint as { entity?: string; a?: { entityId: string } | string; value: { value: number } };
              const anchorId = record.entity ?? (typeof record.a === "object" ? record.a.entityId : record.a);
              const entity = display.find((item) => item.id === anchorId);
              if (!entity) return null;
              const at = entityMidpoint(entity);
              return (
                <text
                  key={constraint.id}
                  className="sketch-dimension"
                  data-testid={`sketch-dimension-${constraint.id}`}
                  x={at.x}
                  y={at.y}
                  transform={`scale(1, -1) translate(0, ${-2 * at.y})`}
                  fontSize={unitsPerPixel * 12}
                >
                  {formatDimension(record.value.value)}
                </text>
              );
            })}
        </g>
      </svg>

      <aside className="sketch-side" aria-label={t("sketch.constraints")}>
        <div className="sketch-side-group">
          <div className="sketch-side-label">{t("sketch.constraints")}</div>
          <div className="sketch-constraint-grid">
            {GEOMETRIC_CONSTRAINTS.map((entry) => (
              <button
                key={entry.type}
                type="button"
                data-testid={`constraint-${entry.type}`}
                title={t(entry.labelKey)}
                aria-label={t(entry.labelKey)}
                onClick={() => addConstraint(entry.type, entry.arity)}
              >
                {t(entry.labelKey).slice(0, 3)}
              </button>
            ))}
          </div>
        </div>

        <div className="sketch-side-group">
          <div className="sketch-side-label">{t("sketch.dimensions")}</div>
          <div className="sketch-constraint-grid">
            {DIMENSION_KINDS.map((entry) => (
              <button
                key={entry.type}
                type="button"
                data-testid={`dimension-${entry.type}`}
                title={t(entry.labelKey)}
                aria-label={t(entry.labelKey)}
                onClick={() => setDimensionDraft({ type: entry.type, expression: "" })}
              >
                {t(entry.labelKey).slice(0, 3)}
              </button>
            ))}
          </div>
          {dimensionDraft ? (
            <form
              className="sketch-dimension-input"
              onSubmit={(event) => {
                event.preventDefault();
                if (addDimension(dimensionDraft.type, dimensionDraft.expression)) setDimensionDraft(null);
              }}
            >
              <input
                autoFocus
                data-testid="dimension-input"
                aria-label={t("sketch.dimensionValue")}
                value={dimensionDraft.expression}
                placeholder={t("sketch.dimensionPlaceholder")}
                onChange={(event) => setDimensionDraft({ ...dimensionDraft, expression: event.target.value })}
              />
              <button type="submit" data-testid="dimension-apply">{t("sketch.apply")}</button>
            </form>
          ) : null}
        </div>

        <div className="sketch-side-group">
          <div className="sketch-side-label">{t("sketch.toolOptions")}</div>
          <label className="sketch-option">
            {t("sketch.offsetDistance")}
            <input
              type="number"
              step={0.5}
              data-testid="sketch-offset-distance"
              value={offsetDistance}
              onChange={(event) => setOffsetDistance(Number.parseFloat(event.target.value) || 0)}
            />
          </label>
          <label className="sketch-option">
            {t("sketch.filletRadius")}
            <input
              type="number"
              min={0}
              step={0.5}
              data-testid="sketch-fillet-radius"
              value={filletRadius}
              onChange={(event) => setFilletRadius(Number.parseFloat(event.target.value) || 0)}
            />
          </label>
          <label className="sketch-option">
            {t("sketch.patternCount")}
            <input
              type="number"
              min={2}
              max={200}
              data-testid="sketch-pattern-count"
              value={patternCount}
              onChange={(event) => setPatternCount(Number.parseInt(event.target.value, 10) || 2)}
            />
          </label>
          <label className="sketch-option">
            {t("sketch.patternSpacing")}
            <input
              type="number"
              step={1}
              data-testid="sketch-pattern-spacing"
              value={patternSpacing}
              onChange={(event) => setPatternSpacing(Number.parseFloat(event.target.value) || 0)}
            />
          </label>
          <div className="sketch-view-buttons">
            <button type="button" data-testid="sketch-pattern-rect" onClick={() => applyPattern("rectangular")}>
              {t("sketch.rectangularPattern")}
            </button>
            <button type="button" data-testid="sketch-pattern-circ" onClick={() => applyPattern("circular")}>
              {t("sketch.circularPattern")}
            </button>
          </div>
        </div>

        <div className="sketch-side-group">
          <label className="sketch-option">
            <input type="checkbox" data-testid="sketch-construction" checked={construction} onChange={(event) => setConstruction(event.target.checked)} />
            {t("sketch.construction")}
          </label>
          <label className="sketch-option">
            {t("sketch.polygonSides")}
            <input
              type="number"
              min={3}
              max={64}
              data-testid="sketch-polygon-sides"
              value={polygonSides}
              onChange={(event) => setPolygonSides(Number.parseInt(event.target.value, 10) || 6)}
            />
          </label>
          <label className="sketch-option">
            {t("sketch.snapStep")}
            <input
              type="number"
              min={0}
              step={0.1}
              data-testid="sketch-snap-step"
              value={snapStep}
              onChange={(event) => setSnapStep(Number.parseFloat(event.target.value) || 0)}
            />
          </label>
        </div>

        <div className="sketch-side-group">
          <div className="sketch-view-buttons">
            <button type="button" data-testid="sketch-zoom-in" aria-label={t("sketch.zoomIn")} onClick={() => zoom(0.8)}>+</button>
            <button type="button" data-testid="sketch-zoom-out" aria-label={t("sketch.zoomOut")} onClick={() => zoom(1.25)}>−</button>
            <button type="button" data-testid="sketch-fit" aria-label={t("sketch.fit")} onClick={fit}>⤢</button>
          </div>
          <button
            type="button"
            className="sketch-parameters-button"
            data-testid="sketch-parameters"
            aria-expanded={parametersOpen}
            onClick={() => setParametersOpen((open) => !open)}
          >
            {t("parameters.title")}
          </button>
        </div>
      </aside>

      {parametersOpen ? (
        <ParametersDialog
          parameters={parameters}
          nextId={nextId}
          onChange={setParameters}
          onClose={() => setParametersOpen(false)}
        />
      ) : null}

      <footer className="sketch-status" data-testid="sketch-status">
        <span data-testid="sketch-dof">
          {solved.degreesOfFreedom === 0
            ? t("sketch.fullyConstrained")
            : t("sketch.degreesOfFreedom", { count: solved.degreesOfFreedom })}
        </span>
        <span data-testid="sketch-counts">{t("sketch.counts", { entities: entities.length, constraints: constraintCount })}</span>
        {solved.conflictingConstraintIds.length > 0 ? (
          <span className="sketch-conflict" data-testid="sketch-conflict">
            {t("sketch.conflicting", { count: solved.conflictingConstraintIds.length })}
          </span>
        ) : null}
        {message ? <span className="sketch-message" data-testid="sketch-message">{message}</span> : null}
        <span className="sketch-status-spacer" />
        <label className="sketch-option">
          {t("sketch.extrudeDistance")}
          <input
            type="number"
            step={1}
            data-testid="sketch-extrude-distance"
            value={extrudeDistance}
            onChange={(event) => setExtrudeDistance(Number.parseFloat(event.target.value) || 0)}
          />
        </label>
        <button type="button" className="secondary" data-testid="parametric-cancel" onClick={onCancel}>
          {t("sketch.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          data-testid="parametric-finish"
          disabled={busy || entities.length === 0}
          onClick={() => onFinish(sketch, extrudeDistance)}
        >
          {t("sketch.finish")}
        </button>
      </footer>
    </div>
  );
}

function ToolButton({
  id,
  active,
  label,
  onSelect,
}: {
  id: SketchTool;
  active: boolean;
  label: string;
  onSelect: (tool: SketchTool) => void;
}) {
  return (
    <button
      type="button"
      className={active ? "active" : ""}
      data-testid={`sketch-tool-${id}`}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => onSelect(id)}
    >
      {label.slice(0, 2)}
    </button>
  );
}

/** The endpoint pair of two entities that is already closest together. */
function nearestEndpointPair(a: SketchEntity | undefined, b: SketchEntity | undefined) {
  if (!a || !b) return null;
  const handlesA = entityHandles(a).filter((handle) => handle.role !== "center");
  const handlesB = entityHandles(b).filter((handle) => handle.role !== "center");

  let bestDistance = Infinity;
  let bestA = -1;
  let bestB = -1;
  for (let first = 0; first < handlesA.length; first += 1) {
    for (let second = 0; second < handlesB.length; second += 1) {
      const distance = distanceVec2(handlesA[first].point, handlesB[second].point);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestA = first;
        bestB = second;
      }
    }
  }
  if (bestA < 0 || bestB < 0) return null;
  return { a: pointRef(a.id, handlesA[bestA].role), b: pointRef(b.id, handlesB[bestB].role) };
}

function formatDimension(value: number) {
  return Number.isFinite(value) ? `${Math.round(value * 100) / 100}` : "?";
}
