import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The layout store is deliberately forgiving about what it reads back.
 *
 * Stored preferences outlive the code that wrote them: a value can come from an
 * older release, a hand-edited entry, or a half-written record. None of those
 * should be able to produce a dock that cannot be dragged back into view, so
 * every path is checked to land on something usable.
 *
 * The unit suite runs in Node, so there is no `window`. Rather than pull in a
 * DOM implementation for one module that touches exactly one browser API, the
 * storage it needs is stubbed here — hoisted, because the store resolves
 * storage on its first read and that happens during import.
 */
const storage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  return { entries, localStorage };
});

const {
  DEFAULT_LAYOUT,
  MAX_BROWSER_WIDTH,
  MIN_BROWSER_WIDTH,
  getEditorLayout,
  setEditorLayout,
} = await import("@/lib/editorLayout");

const STORAGE_KEY = "sketchForge.layout";

function stored() {
  const raw = storage.localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

beforeEach(() => {
  setEditorLayout(DEFAULT_LAYOUT);
  storage.entries.clear();
});

afterEach(() => {
  storage.entries.clear();
});

describe("editor layout", () => {
  it("starts from the defaults", () => {
    expect(getEditorLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("persists a change", () => {
    setEditorLayout({ browserOpen: false });

    expect(getEditorLayout().browserOpen).toBe(false);
    expect(stored()).toMatchObject({ browserOpen: false });
  });

  it("keeps the fields it was not asked to change", () => {
    setEditorLayout({ browserWidth: 320 });
    setEditorLayout({ browserOpen: false });

    expect(getEditorLayout()).toEqual({ browserOpen: false, browserWidth: 320 });
  });

  it("clamps a width below the readable minimum", () => {
    setEditorLayout({ browserWidth: 20 });
    expect(getEditorLayout().browserWidth).toBe(MIN_BROWSER_WIDTH);
  });

  it("clamps a width that would crowd out the model", () => {
    setEditorLayout({ browserWidth: 5_000 });
    expect(getEditorLayout().browserWidth).toBe(MAX_BROWSER_WIDTH);
  });

  it("rounds a fractional width", () => {
    // Pointer positions on a scaled display are fractional; a stored 268.5
    // would come back as a sub-pixel column and blur the dock's border.
    setEditorLayout({ browserWidth: 268.5 });
    expect(getEditorLayout().browserWidth).toBe(269);
  });

  it("falls back when the width is not a number", () => {
    setEditorLayout({ browserWidth: Number.NaN });
    expect(getEditorLayout().browserWidth).toBe(DEFAULT_LAYOUT.browserWidth);
  });

  it("writes nothing when the patch changes nothing", () => {
    setEditorLayout({ browserOpen: true });
    expect(stored()).toBeNull();
  });

  it("survives storage that throws", () => {
    const setItem = storage.localStorage.setItem;
    storage.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };

    // The arrangement still has to apply for this session — a full disk is not
    // a reason for the panel to refuse to move.
    expect(() => setEditorLayout({ browserWidth: 300 })).not.toThrow();
    expect(getEditorLayout().browserWidth).toBe(300);

    storage.localStorage.setItem = setItem;
  });
});
