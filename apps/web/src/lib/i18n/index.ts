// Bilingual user interface.
//
// SketchForge is used in German classrooms and maintained as an English-language
// open-source project, so the interface speaks both. This is a deliberately
// small implementation — no dependency, no bundler plugin, no message compiler:
// a flat dictionary, a module-level store, and one hook.
//
// The store lives outside React so that non-component code (notices raised from
// callbacks, worker error messages) can translate too, and `useSyncExternalStore`
// keeps components in step. The server snapshot is fixed to the default language
// so hydration cannot mismatch; the stored preference is applied immediately
// afterwards.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { TRANSLATIONS, type TranslationKey } from "@/lib/i18n/translations";

export type Language = "de" | "en";

export const LANGUAGES: readonly Language[] = ["en", "de"];
export const DEFAULT_LANGUAGE: Language = "en";
const STORAGE_KEY = "sketchForge.language";

export type TranslationVars = Record<string, string | number>;

function isLanguage(value: unknown): value is Language {
  return value === "de" || value === "en";
}

/** The stored preference, else the browser's language, else English. */
function detectLanguage(): Language {
  if (typeof window === "undefined") return DEFAULT_LANGUAGE;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(stored)) return stored;
  } catch {
    // Storage can be unavailable in private modes; fall through to the browser.
  }
  const preferred = typeof navigator === "undefined" ? "" : navigator.language;
  return preferred.toLowerCase().startsWith("de") ? "de" : DEFAULT_LANGUAGE;
}

let currentLanguage: Language = DEFAULT_LANGUAGE;
let detected = false;
const listeners = new Set<() => void>();

function snapshot(): Language {
  // Resolving on first read rather than at module load keeps this correct when
  // the module is evaluated during server rendering.
  if (!detected && typeof window !== "undefined") {
    detected = true;
    currentLanguage = detectLanguage();
  }
  return currentLanguage;
}

function serverSnapshot(): Language {
  return DEFAULT_LANGUAGE;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLanguage(): Language {
  return snapshot();
}

export function setLanguage(next: Language) {
  if (!isLanguage(next) || next === snapshot()) return;
  detected = true;
  currentLanguage = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice still applies for this session without storage.
  }
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

/**
 * Substitutes `{name}` placeholders. Unknown placeholders are left in place
 * rather than blanked, so a missing variable is visible instead of silent.
 */
export function format(template: string, vars?: TranslationVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Translates a key outside React.
 *
 * A missing translation falls back to English and then to the key itself, so a
 * gap shows up as a readable identifier rather than an empty control.
 */
export function translate(key: TranslationKey, vars?: TranslationVars, language: Language = snapshot()): string {
  const entry = TRANSLATIONS[key];
  if (!entry) return key;
  return format(entry[language] ?? entry.en ?? key, vars);
}

/**
 * Picks between a one-form and a many-form message.
 *
 * Both German and English split at exactly one for the quantities this
 * interface reports, so two forms are enough; `count` is passed through as a
 * variable so the message can place it wherever the language needs it.
 */
export function translatePlural(
  count: number,
  oneKey: TranslationKey,
  otherKey: TranslationKey,
  vars?: TranslationVars,
  language: Language = snapshot(),
): string {
  return translate(count === 1 ? oneKey : otherKey, { count, ...vars }, language);
}

export type Translator = (key: TranslationKey, vars?: TranslationVars) => string;

export function useTranslation() {
  const language = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const t = useCallback<Translator>((key, vars) => translate(key, vars, language), [language]);
  return useMemo(() => ({ language, t, setLanguage }), [language, t]);
}

export { TRANSLATIONS, type TranslationKey } from "@/lib/i18n/translations";
