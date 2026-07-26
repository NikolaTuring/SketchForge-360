"use client";

import { useState } from "react";

import { useTranslation } from "@/lib/i18n";
import type { SketchPlaneRef } from "@/types/sketch";

/**
 * Choosing the plane a sketch lives on.
 *
 * Three base planes and an offset. The offset is what makes a base plane useful
 * beyond the first feature — a boss on top of a 10 mm plate is a sketch on the
 * ground plane offset by 10, and without it every such sketch would need a
 * construction body first.
 *
 * Picking a face on an existing body is the other half of this and belongs to
 * the viewport, which is where a face can be clicked.
 */

const BASE_PLANES = [
  { plane: "xy", labelKey: "browser.plane.xy" },
  { plane: "xz", labelKey: "browser.plane.xz" },
  { plane: "yz", labelKey: "browser.plane.yz" },
] as const;

export function SketchPlanePicker({
  onStart,
  onCancel,
}: {
  onStart: (plane: SketchPlaneRef) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [plane, setPlane] = useState<"xy" | "xz" | "yz">("xz");
  const [offset, setOffset] = useState(0);

  return (
    <div className="sketch-plane-picker" data-testid="sketch-plane-picker" role="dialog" aria-label={t("sketch.choosePlane")}>
      <div className="sketch-plane-title">{t("sketch.choosePlane")}</div>

      <div className="sketch-plane-options" role="radiogroup" aria-label={t("sketch.choosePlane")}>
        {BASE_PLANES.map((entry) => (
          <button
            key={entry.plane}
            type="button"
            role="radio"
            aria-checked={plane === entry.plane}
            className={plane === entry.plane ? "active" : ""}
            data-testid={`sketch-plane-${entry.plane}`}
            onClick={() => setPlane(entry.plane)}
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      <label className="sketch-option">
        {t("sketch.planeOffset")}
        <input
          type="number"
          step={1}
          data-testid="sketch-plane-offset"
          value={offset}
          onChange={(event) => setOffset(Number.parseFloat(event.target.value) || 0)}
        />
      </label>

      <div className="sketch-plane-actions">
        <button type="button" className="secondary" data-testid="sketch-plane-cancel" onClick={onCancel}>
          {t("sketch.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          data-testid="sketch-plane-start"
          onClick={() => onStart({ kind: "base", plane, offset })}
        >
          {t("sketch.startSketch")}
        </button>
      </div>
    </div>
  );
}
