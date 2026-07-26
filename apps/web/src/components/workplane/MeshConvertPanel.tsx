"use client";

import { useState } from "react";

import { useTranslation } from "@/lib/i18n";
import type { MeshConversionReport } from "@/lib/brepFeatureTypes";
import type { MeshConversionSettings } from "@/lib/meshToBrep";

/**
 * Surface recognition for an imported mesh.
 *
 * The panel exists to be honest. An STL that came out of a scanner and one that
 * came out of a CAD program look identical in the viewport, and only one of them
 * can be turned back into clean geometry. Rather than guessing and quietly
 * producing a slightly-wrong solid, this reports what was recognised, how much
 * of the surface it accounts for, and what is left over — and lets the user
 * decide.
 *
 * The tolerances are exposed for the same reason. A scanned part needs a looser
 * angle tolerance than a tessellated one, and burying that choice would make
 * "it did not work" the only available diagnosis.
 */

export type MeshConvertPanelProps = {
  bodyName: string;
  report: MeshConversionReport | null;
  busy: boolean;
  settings: MeshConversionSettings;
  onSettingsChange: (settings: MeshConversionSettings) => void;
  onRun: () => void;
  onClose: () => void;
};

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function MeshConvertPanel({
  bodyName,
  report,
  busy,
  settings,
  onSettingsChange,
  onRun,
  onClose,
}: MeshConvertPanelProps) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);

  const set = (patch: MeshConversionSettings) => onSettingsChange({ ...settings, ...patch });

  return (
    <aside className="mesh-convert-panel" data-testid="mesh-convert-panel" aria-label={t("mesh.convertTitle")}>
      <header>
        <strong>{t("mesh.convertTitle")}</strong>
        <button type="button" data-testid="mesh-convert-close" aria-label={t("mesh.close")} onClick={onClose}>
          {"×"}
        </button>
      </header>

      <div className="mesh-convert-body">
        <p className="mesh-convert-target" data-testid="mesh-convert-target">{bodyName}</p>

        <label className="sketch-option">
          {t("mesh.angleTolerance")}
          <input
            type="number"
            min={1}
            max={45}
            step={1}
            data-testid="mesh-angle-tolerance"
            value={settings.angleTolerance ?? 12}
            onChange={(event) => set({ angleTolerance: Number.parseFloat(event.target.value) || 12 })}
          />
        </label>

        <label className="sketch-option">
          {t("mesh.tolerance")}
          <input
            type="number"
            min={0.001}
            step={0.01}
            data-testid="mesh-tolerance"
            value={settings.tolerance ?? 0.05}
            onChange={(event) => set({ tolerance: Number.parseFloat(event.target.value) || 0.05 })}
          />
        </label>

        <button
          type="button"
          className="mesh-convert-advanced"
          data-testid="mesh-advanced-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((open) => !open)}
        >
          {t("mesh.advanced")}
        </button>

        {advanced ? (
          <>
            <label className="sketch-option">
              {t("mesh.dimensionGrid")}
              <input
                type="number"
                min={0}
                step={0.05}
                data-testid="mesh-dimension-grid"
                value={settings.dimensionGrid ?? 0.1}
                onChange={(event) => set({ dimensionGrid: Number.parseFloat(event.target.value) || 0 })}
              />
            </label>
            <label className="sketch-option">
              <input
                type="checkbox"
                data-testid="mesh-snap-axes"
                checked={settings.snapToWorldAxes ?? true}
                onChange={(event) => set({ snapToWorldAxes: event.target.checked })}
              />
              {t("mesh.snapAxes")}
            </label>
            <label className="sketch-option">
              <input
                type="checkbox"
                data-testid="mesh-coaxial"
                checked={settings.enforceCoaxial ?? true}
                onChange={(event) => set({ enforceCoaxial: event.target.checked })}
              />
              {t("mesh.coaxial")}
            </label>
          </>
        ) : null}

        <button type="button" className="primary" data-testid="mesh-convert-run" disabled={busy} onClick={onRun}>
          {busy ? t("mesh.working") : t("mesh.recognise")}
        </button>

        {report ? (
          <div className="mesh-convert-report" data-testid="mesh-convert-report">
            <dl>
              <dt>{t("mesh.planes")}</dt>
              <dd data-testid="mesh-count-plane">{report.tally.plane}</dd>
              <dt>{t("mesh.cylinders")}</dt>
              <dd data-testid="mesh-count-cylinder">{report.tally.cylinder}</dd>
              <dt>{t("mesh.cones")}</dt>
              <dd data-testid="mesh-count-cone">{report.tally.cone}</dd>
              <dt>{t("mesh.spheres")}</dt>
              <dd data-testid="mesh-count-sphere">{report.tally.sphere}</dd>
              <dt>{t("mesh.coverage")}</dt>
              <dd data-testid="mesh-coverage">{percent(report.coverage)}</dd>
              <dt>{t("mesh.triangles")}</dt>
              <dd data-testid="mesh-triangles">{report.triangleCount}</dd>
            </dl>

            {/*
              The verdict, stated plainly. A mesh that is not closed cannot
              become a solid no matter how well its surfaces were recognised,
              and that is the single most useful thing to know before spending
              time on tolerances.
            */}
            <p className={report.manifold ? "mesh-verdict good" : "mesh-verdict bad"} data-testid="mesh-verdict">
              {report.manifold
                ? t("mesh.closed")
                : t("mesh.notClosed", { boundary: report.boundaryEdges, nonManifold: report.nonManifoldEdges })}
            </p>

            {report.unassignedTriangles > 0 ? (
              <p className="mesh-leftover" data-testid="mesh-leftover">
                {t("mesh.leftover", { count: report.unassignedTriangles })}
              </p>
            ) : null}

            {report.axesSnappedToWorld > 0 || report.dimensionsRounded > 0 || report.coaxialGroups > 0 ? (
              <p className="mesh-cleanup" data-testid="mesh-cleanup">
                {t("mesh.cleanup", {
                  axes: report.axesSnappedToWorld,
                  rounded: report.dimensionsRounded,
                  coaxial: report.coaxialGroups,
                })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
