"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { contextMenuGroups, type EditorCommand } from "@/lib/commandRegistry";
import { useTranslation } from "@/lib/i18n";

/**
 * The right-click menu.
 *
 * It draws from the same registry as the ribbon and the command search, so a
 * command cannot be available in one and missing from another. What differs is
 * the editing: this is a shortlist of what people reach for most, resolved
 * against the current selection, and entries that do not apply are left out
 * rather than greyed out — a menu at the cursor has no layout worth preserving,
 * and a shorter list is quicker to aim at.
 */

export type ContextMenuState = { x: number; y: number };

export function ContextMenu({
  commands,
  state,
  onClose,
}: {
  commands: readonly EditorCommand[];
  state: ContextMenuState | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [placed, setPlaced] = useState<ContextMenuState | null>(null);

  /*
   * Nudge the menu back on screen once it has been measured.
   *
   * A right-click near the bottom or right edge would otherwise open a menu
   * that runs off the window, and the entries furthest from the cursor — which
   * include Delete — would be unreachable.
   *
   * The menu therefore renders at the raw cursor position first, so there is
   * something to measure, and is corrected here. This has to be a layout effect
   * on the render that *already contains* the menu: an effect that runs before
   * the element exists measures nothing and silently leaves the menu where it
   * was. `visibility` keeps the uncorrected first pass off the screen.
   */
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!state || !menu) {
      setPlaced(null);
      return;
    }
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    setPlaced({
      x: Math.max(margin, Math.min(state.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(state.y, window.innerHeight - rect.height - margin)),
    });
  }, [state]);

  useEffect(() => {
    if (!state) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The editor's global Escape clears the selection; dismissing a menu is
      // not a request to do that.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose, state]);

  if (!state) return null;

  const groups = contextMenuGroups(commands);
  if (groups.length === 0) return null;

  const position = placed ?? state;

  return (
    <>
      {/*
        A full-window backdrop, so any click anywhere dismisses the menu —
        including a click on the viewport, which would otherwise start an
        orbit with the menu still floating over it.
      */}
      <div className="context-menu-backdrop" onPointerDown={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        className="context-menu"
        data-testid="context-menu"
        role="menu"
        style={{ left: `${position.x}px`, top: `${position.y}px`, visibility: placed ? undefined : "hidden" }}
      >
        {groups.map((group, index) => (
          <div className="context-menu-group" key={group[0]?.id ?? index}>
            {group.map((command) => (
              <button
                key={command.id}
                className="context-menu-item"
                data-testid={`context-${command.id}`}
                type="button"
                role="menuitem"
                onClick={() => {
                  command.run();
                  onClose();
                }}
              >
                {t(command.labelKey)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
