"use client";

import { useEffect } from "react";
import { LANGUAGES, useTranslation, type Language } from "@/lib/i18n";

/**
 * Switches the interface language.
 *
 * A plain `<select>` rather than a flag menu: flags stand for countries, not
 * languages, and a select is reachable by keyboard and screen reader without
 * any extra work. It lives in the ribbon's Manage group for now and moves to the
 * quick-access bar once that exists.
 */
export function LanguageSwitch({ className }: { className?: string }) {
  const { language, setLanguage, t } = useTranslation();

  // The document's language drives screen-reader pronunciation and the browser's
  // own spellchecking, so it has to follow the interface — including on first
  // load, where the preference is detected rather than chosen.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <label className={`language-switch ${className ?? ""}`}>
      <span className="sr-only">{t("language.label")}</span>
      <select
        data-testid="language-switch"
        aria-label={t("language.label")}
        value={language}
        onChange={(event) => setLanguage(event.currentTarget.value as Language)}
      >
        {LANGUAGES.map((code) => (
          <option key={code} value={code}>
            {t(code === "de" ? "language.de" : "language.en")}
          </option>
        ))}
      </select>
    </label>
  );
}
