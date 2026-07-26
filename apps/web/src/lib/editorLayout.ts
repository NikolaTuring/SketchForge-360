// Dock layout: which panels are open, and how wide.
//
// Kept outside React for the same reason the language store is: the layout is a
// property of the workstation, not of a component tree, and the editor is not
// the only thing that reads it. It follows the same shape — a module-level
// value, `useSyncExternalStore`, and a fixed server snapshot so hydration
// cannot mismatch.
//
// A layout is a preference, not a document. It is stored per browser and is
// deliberately *not* part of the project file: two people opening the same
// `.skf` should each keep their own panel arrangement.

import { useCallback, useMemo, useSyncExternalStore } from "react";

export type EditorLayout = {
  /** The model browser on the left. */
  browserOpen: boolean;
  browserWidth: number;
  /** The properties dock on the right. */
  propertiesOpen: boolean;
};

export const DEFAULT_LAYOUT: EditorLayout = {
  browserOpen: true,
  browserWidth: 268,
  propertiesOpen: true,
};

/**
 * Width bounds for the browser dock.
 *
 * The lower bound is where a body name stops being readable, the upper bound is
 * where the dock starts competing with the model for the window. Both are
 * enforced on read as well as on write, so a hand-edited or stale stored value
 * cannot produce a dock that cannot be dragged back.
 */
export const MIN_BROWSER_WIDTH = 180;
export const MAX_BROWSER_WIDTH = 480;

/**
 * Below this the docks stop being columns and become overlay drawers.
 *
 * At 1100 px a browser dock plus a properties dock leave the viewport too
 * narrow to model in — the panels would win an argument they should lose.
 */
export const DOCK_OVERLAY_BREAKPOINT = 1100;

const STORAGE_KEY = "sketchForge.layout";

function clampWidth(value: unknown): number {
  const width = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_LAYOUT.browserWidth;
  return Math.max(MIN_BROWSER_WIDTH, Math.min(MAX_BROWSER_WIDTH, Math.round(width)));
}

function parseLayout(raw: string | null): EditorLayout {
  if (!raw) return DEFAULT_LAYOUT;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_LAYOUT;
    const record = parsed as Partial<Record<keyof EditorLayout, unknown>>;
    return {
      browserOpen: typeof record.browserOpen === "boolean" ? record.browserOpen : DEFAULT_LAYOUT.browserOpen,
      browserWidth: clampWidth(record.browserWidth),
      propertiesOpen: typeof record.propertiesOpen === "boolean" ? record.propertiesOpen : DEFAULT_LAYOUT.propertiesOpen,
    };
  } catch {
    // A corrupt entry is not worth reporting to someone who wanted to model.
    return DEFAULT_LAYOUT;
  }
}

let current: EditorLayout = DEFAULT_LAYOUT;
let loaded = false;
const listeners = new Set<() => void>();

function snapshot(): EditorLayout {
  if (!loaded && typeof window !== "undefined") {
    loaded = true;
    try {
      current = parseLayout(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      current = DEFAULT_LAYOUT;
    }
  }
  return current;
}

function serverSnapshot(): EditorLayout {
  return DEFAULT_LAYOUT;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEditorLayout(): EditorLayout {
  return snapshot();
}

export function setEditorLayout(patch: Partial<EditorLayout>) {
  const previous = snapshot();
  const next: EditorLayout = {
    ...previous,
    ...patch,
    browserWidth: clampWidth(patch.browserWidth ?? previous.browserWidth),
  };
  if (
    next.browserOpen === previous.browserOpen
    && next.browserWidth === previous.browserWidth
    && next.propertiesOpen === previous.propertiesOpen
  ) {
    return;
  }

  loaded = true;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The arrangement still applies for this session without storage.
  }
  listeners.forEach((listener) => listener());
}

export function useEditorLayout() {
  const layout = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const update = useCallback((patch: Partial<EditorLayout>) => setEditorLayout(patch), []);
  return useMemo(() => ({ layout, setLayout: update }), [layout, update]);
}
