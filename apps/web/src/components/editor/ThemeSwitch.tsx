"use client";

import { useTranslation } from "@/lib/i18n";
import { THEME_CHOICES, useTheme, type ThemeChoice } from "@/lib/theme";

/**
 * Switches between the light and dark interface.
 *
 * A `<select>` with three entries rather than a two-state toggle, because
 * "follow the system" is a real third choice: a machine that switches at dusk
 * should take the editor with it, and a toggle can only ever record the answer
 * for right now.
 */
export function ThemeSwitch({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <label className={`theme-switch ${className ?? ""}`}>
      <span className="sr-only">{t("theme.label")}</span>
      <select
        data-testid="theme-switch"
        aria-label={t("theme.label")}
        value={theme}
        onChange={(event) => setTheme(event.currentTarget.value as ThemeChoice)}
      >
        {THEME_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {t(`theme.${choice}` as "theme.system" | "theme.light" | "theme.dark")}
          </option>
        ))}
      </select>
    </label>
  );
}
