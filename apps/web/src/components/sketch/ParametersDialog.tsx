"use client";

import { useMemo } from "react";

import { evaluateParameterTable, type SketchParameter } from "@/lib/parameterExpressions";
import { useTranslation } from "@/lib/i18n";

/**
 * The sketch's named parameters.
 *
 * A dimension can be typed as a number, but a part is rarely made of unrelated
 * numbers: a wall thickness appears in six places, and changing it in six places
 * is how one of them gets missed. Naming it once and writing `wandstaerke * 3`
 * makes that impossible.
 *
 * Every row is evaluated live, in dependency order, and an error is shown next
 * to the row that caused it rather than as one message for the table. A cycle is
 * reported as a cycle rather than silently resolving to zero.
 *
 * The parameters belong to the sketch. Sharing them across a whole project is
 * the obvious next step and is not built yet; keeping them here means they save
 * and load with the body that uses them instead of being a second thing to
 * remember to send along.
 */

export type ParametersDialogProps = {
  parameters: readonly SketchParameter[];
  onChange: (parameters: SketchParameter[]) => void;
  onClose: () => void;
  nextId: () => string;
};

export function ParametersDialog({ parameters, onChange, onClose, nextId }: ParametersDialogProps) {
  const { t } = useTranslation();
  const result = useMemo(() => evaluateParameterTable(parameters), [parameters]);

  const update = (id: string, patch: Partial<SketchParameter>) =>
    onChange(parameters.map((parameter) => (parameter.id === id ? { ...parameter, ...patch } : parameter)));

  return (
    <div className="parameters-dialog" data-testid="parameters-dialog" role="dialog" aria-label={t("parameters.title")}>
      <header>
        <strong>{t("parameters.title")}</strong>
        <button type="button" data-testid="parameters-close" aria-label={t("mesh.close")} onClick={onClose}>
          {"×"}
        </button>
      </header>

      <div className="parameters-body">
        {parameters.length === 0 ? (
          <p className="parameters-empty" data-testid="parameters-empty">{t("parameters.empty")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("parameters.name")}</th>
                <th>{t("parameters.expression")}</th>
                <th>{t("parameters.value")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {parameters.map((parameter) => {
                const error = result.errors.get(parameter.id);
                const value = result.values.get(parameter.name);
                return (
                  <tr key={parameter.id} className={error ? "invalid" : ""} data-testid={`parameter-row-${parameter.id}`}>
                    <td>
                      <input
                        aria-label={t("parameters.name")}
                        data-testid={`parameter-name-${parameter.id}`}
                        value={parameter.name}
                        onChange={(event) => update(parameter.id, { name: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={t("parameters.expression")}
                        data-testid={`parameter-expression-${parameter.id}`}
                        value={parameter.expression}
                        onChange={(event) => update(parameter.id, { expression: event.target.value })}
                      />
                    </td>
                    <td className="parameters-value" data-testid={`parameter-value-${parameter.id}`}>
                      {/*
                        The error replaces the value rather than sitting beside
                        it: a stale number next to a broken expression is the one
                        thing that could make someone trust a wrong dimension.
                      */}
                      {error ?? (value === undefined ? "—" : Math.round(value * 1000) / 1000)}
                    </td>
                    <td>
                      <button
                        type="button"
                        data-testid={`parameter-delete-${parameter.id}`}
                        aria-label={t("parameters.remove")}
                        onClick={() => onChange(parameters.filter((entry) => entry.id !== parameter.id))}
                      >
                        {"×"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <button
          type="button"
          className="primary"
          data-testid="parameters-add"
          onClick={() =>
            onChange([...parameters, { id: nextId(), name: `p${parameters.length + 1}`, expression: "10", unit: "length" }])
          }
        >
          {t("parameters.add")}
        </button>
      </div>
    </div>
  );
}
