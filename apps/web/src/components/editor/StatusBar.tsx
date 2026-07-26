"use client";

import { formatMeasurementNumber, lengthDisplayUnit, millimetersToDisplay } from "@/lib/measurementUnits";
import { useTranslation } from "@/lib/i18n";
import type { GridSize, WorkplaneShape, WorkplaneWorkspaceSettings } from "@/types/sketchforge";

/**
 * The status bar: what is selected, how big it is, and what the numbers mean.
 *
 * The last part is the point. Every measurement elsewhere in the editor is a
 * bare number, and a bare number is ambiguous — 25 is a very different part in
 * millimetres than in centimetres. Naming the unit once, permanently, in a place
 * that is always on screen is cheaper than repeating it on every field.
 */

export type StatusBarProps = {
  shapes: readonly WorkplaneShape[];
  selectedShapes: readonly WorkplaneShape[];
  workspace: WorkplaneWorkspaceSettings;
  snapGrid: GridSize;
  notice: string;
};

/** The selection's bounding box in display units, or null when nothing is selected. */
function selectionExtent(
  selected: readonly WorkplaneShape[],
  workspace: Pick<WorkplaneWorkspaceSettings, "units" | "scale">,
) {
  if (selected.length === 0) return null;
  const toDisplay = (value: number) => millimetersToDisplay(value, workspace);
  return {
    width: toDisplay(Math.max(...selected.map((shape) => shape.width))),
    depth: toDisplay(Math.max(...selected.map((shape) => shape.depth))),
    height: toDisplay(Math.max(...selected.map((shape) => shape.height))),
  };
}

export function StatusBar({ shapes, selectedShapes, workspace, snapGrid, notice }: StatusBarProps) {
  const { t } = useTranslation();
  const unit = lengthDisplayUnit(workspace);
  const extent = selectionExtent(selectedShapes, workspace);
  const hiddenCount = shapes.filter((shape) => shape.hidden).length;
  const format = (value: number) => formatMeasurementNumber(value, workspace.accuracy);

  return (
    <footer className="editor-status-bar" data-testid="status-bar" role="status" aria-live="polite">
      <span className="status-notice" data-testid="status-notice">{notice}</span>

      <span className="status-spacer" />

      {hiddenCount > 0 ? (
        <span className="status-field" data-testid="status-hidden">
          {t("status.hidden", { count: hiddenCount })}
        </span>
      ) : null}

      <span className="status-field" data-testid="status-selection">
        {selectedShapes.length === 0
          ? t("status.noSelection")
          : t("status.selection", { count: selectedShapes.length })}
      </span>

      {extent ? (
        <span className="status-field" data-testid="status-extent">
          {`${format(extent.width)} × ${format(extent.depth)} × ${format(extent.height)} ${unit.label}`}
        </span>
      ) : null}

      <span className="status-field" data-testid="status-snap">
        {t("status.snap", { value: snapGrid === "Off" ? t("status.snapOff") : snapGrid })}
      </span>

      <span className="status-field status-unit" data-testid="status-unit">
        {t("status.unit", { unit: unit.label })}
      </span>
    </footer>
  );
}
