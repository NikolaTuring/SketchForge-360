// Light and dark.
//
// Same shape as the language and layout stores: a module-level value, a
// `useSyncExternalStore` hook, and a fixed server snapshot so hydration cannot
// mismatch. The choice is a preference of the workstation, not of the document.
//
// "System" is a real third state, not a synonym for whichever theme is current.
// Someone whose machine switches at dusk wants the editor to switch with it, and
// collapsing that to a resolved value the first time it is read would freeze
// them in whatever it happened to be at that moment.

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];

const STORAGE_KEY = "sketchForge.theme";

function isChoice(value: unknown): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

let current: ThemeChoice = "system";
let loaded = false;
const listeners = new Set<() => void>();

function snapshot(): ThemeChoice {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isChoice(stored)) current = stored;
    } catch {
      // Private modes can refuse storage; the system default still applies.
    }
  }
  return current;
}

function serverSnapshot(): ThemeChoice {
  return "system";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Writes the choice onto the document element.
 *
 * "System" removes the attribute rather than setting a resolved value, because
 * the stylesheet's `prefers-color-scheme` rule is written to apply only when no
 * attribute is present. That keeps one source of truth and lets the browser do
 * the switching.
 */
export function applyTheme(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

export function getTheme(): ThemeChoice {
  return snapshot();
}

export function setTheme(next: ThemeChoice) {
  if (!isChoice(next) || next === snapshot()) return;
  loaded = true;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The choice still applies for this session without storage.
  }
  applyTheme(next);
  listeners.forEach((listener) => listener());
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const choose = useCallback((next: ThemeChoice) => setTheme(next), []);
  return useMemo(() => ({ theme, setTheme: choose }), [choose, theme]);
}
