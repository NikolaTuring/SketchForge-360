"use client";

import { ChevronDown, ChevronRight, Eye, EyeOff, LockKeyhole, LockKeyholeOpen } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { MAX_BROWSER_WIDTH, MIN_BROWSER_WIDTH } from "@/lib/editorLayout";
import { useTranslation, type Translator } from "@/lib/i18n";
import type { WorkplaneShape } from "@/types/sketchforge";

/**
 * The model browser: what the document contains, as a tree.
 *
 * The viewport answers "where is it"; this answers "what is there" — including
 * the things the viewport cannot show, like a hidden body or a locked one. That
 * is the whole reason it exists: without it, hiding a body makes it
 * unreachable, and the only way back is a command that unhides *everything*.
 *
 * The tree reads `WorkplaneShape` directly. There is no separate browser model
 * to keep in step, and a body that exists in the scene therefore cannot fail to
 * appear here.
 */

export type ModelBrowserProps = {
  shapes: readonly WorkplaneShape[];
  selectedIds: readonly string[];
  documentName: string;
  width: number;
  onSelect: (id: string | string[] | null, mode?: "replace" | "toggle") => void;
  onUpdateShape: (id: string, patch: Partial<WorkplaneShape>) => void;
  onWidthChange: (width: number) => void;
  onClose: () => void;
};

/** A body's icon is its kind, spelled out — a shape gallery in miniature. */
function KindGlyph({ kind }: { kind: string }) {
  return (
    <span className="browser-kind" aria-hidden="true">
      {kind.slice(0, 2).toUpperCase()}
    </span>
  );
}

type BodyRowProps = {
  shape: WorkplaneShape;
  depth: number;
  selected: boolean;
  /** True when an ancestor is hidden, so this body is not on screen either. */
  inheritedHidden: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelect: (id: string, additive: boolean) => void;
  onUpdateShape: (id: string, patch: Partial<WorkplaneShape>) => void;
  t: Translator;
};

function BodyRow({
  shape,
  depth,
  selected,
  inheritedHidden,
  expanded,
  onToggleExpanded,
  onSelect,
  onUpdateShape,
  t,
}: BodyRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(shape.name);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const children = shape.groupedShapes ?? [];
  const hidden = Boolean(shape.hidden) || inheritedHidden;
  const locked = Boolean(shape.locked);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const commitRename = useCallback(() => {
    setRenaming(false);
    const name = draft.trim();
    // An empty name would leave a row that cannot be told apart from its
    // neighbours, so a blank entry reverts rather than being stored.
    if (!name || name === shape.name) {
      setDraft(shape.name);
      return;
    }
    onUpdateShape(shape.id, { name });
  }, [draft, onUpdateShape, shape.id, shape.name]);

  const handleRenameKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
      return;
    }
    if (event.key === "Escape") {
      // Stop here: the editor's global handler reads Escape as "clear the
      // selection", which is not what someone abandoning a rename means.
      event.preventDefault();
      event.stopPropagation();
      setDraft(shape.name);
      setRenaming(false);
    }
  };

  return (
    <>
      <li
        className={`browser-row ${selected ? "selected" : ""} ${hidden ? "hidden-body" : ""}`}
        data-testid={`browser-row-${shape.id}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {children.length > 0 ? (
          <button
            className="browser-twisty"
            data-testid={`browser-twisty-${shape.id}`}
            type="button"
            aria-label={expanded ? t("browser.collapseGroup") : t("browser.expandGroup")}
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            {expanded ? <ChevronDown size={14} strokeWidth={2.6} /> : <ChevronRight size={14} strokeWidth={2.6} />}
          </button>
        ) : (
          <span className="browser-twisty placeholder" aria-hidden="true" />
        )}

        <KindGlyph kind={shape.kind} />

        {renaming ? (
          <input
            ref={inputRef}
            className="browser-rename"
            data-testid={`browser-rename-${shape.id}`}
            value={draft}
            aria-label={t("browser.renameBody")}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={handleRenameKey}
          />
        ) : (
          <button
            className="browser-name"
            data-testid={`browser-name-${shape.id}`}
            type="button"
            aria-pressed={selected}
            onClick={(event) => onSelect(shape.id, event.ctrlKey || event.metaKey || event.shiftKey)}
            onDoubleClick={() => {
              setDraft(shape.name);
              setRenaming(true);
            }}
          >
            {shape.name}
          </button>
        )}

        <button
          className={`browser-toggle ${hidden ? "off" : ""}`}
          data-testid={`browser-visibility-${shape.id}`}
          type="button"
          // A body hidden because its group is hidden cannot be shown on its
          // own; saying so is better than a control that appears to do nothing.
          disabled={inheritedHidden}
          aria-label={shape.hidden ? t("browser.showBody") : t("browser.hideBody")}
          title={inheritedHidden ? t("browser.hiddenByGroup") : undefined}
          onClick={() => onUpdateShape(shape.id, { hidden: !shape.hidden })}
        >
          {hidden ? <EyeOff size={15} strokeWidth={2.2} /> : <Eye size={15} strokeWidth={2.2} />}
        </button>

        <button
          className={`browser-toggle ${locked ? "on" : ""}`}
          data-testid={`browser-lock-${shape.id}`}
          type="button"
          aria-label={locked ? t("browser.unlockBody") : t("browser.lockBody")}
          onClick={() => onUpdateShape(shape.id, { locked: !locked })}
        >
          {locked ? <LockKeyhole size={15} strokeWidth={2.2} /> : <LockKeyholeOpen size={15} strokeWidth={2.2} />}
        </button>
      </li>

      {expanded
        ? children.map((child) => (
            <BodyRow
              key={child.id}
              shape={child}
              depth={depth + 1}
              // Group members are not independently selectable in the scene, so
              // showing them as selectable here would promise something the
              // viewport does not honour.
              selected={false}
              inheritedHidden={hidden}
              expanded={false}
              onToggleExpanded={() => {}}
              onSelect={() => onSelect(shape.id, false)}
              onUpdateShape={onUpdateShape}
              t={t}
            />
          ))
        : null}
    </>
  );
}

export function ModelBrowser({
  shapes,
  selectedIds,
  documentName,
  width,
  onSelect,
  onUpdateShape,
  onWidthChange,
  onClose,
}: ModelBrowserProps) {
  const { t } = useTranslation();
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const [originOpen, setOriginOpen] = useState(false);
  const [bodiesOpen, setBodiesOpen] = useState(true);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const selectBody = useCallback(
    (id: string, additive: boolean) => onSelect(id, additive ? "toggle" : "replace"),
    [onSelect],
  );

  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resize = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onWidthChange(drag.startWidth + (event.clientX - drag.startX));
  };

  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <aside className="model-browser" data-testid="model-browser" style={{ width: `${width}px` }} aria-label={t("browser.title")}>
      <header className="browser-header">
        <strong>{t("browser.title")}</strong>
        <button
          className="browser-header-button"
          data-testid="browser-close"
          type="button"
          aria-label={t("browser.hidePanel")}
          onClick={onClose}
        >
          {"×"}
        </button>
      </header>

      <div className="browser-scroll">
        <div className="browser-document">{documentName}</div>

        <button
          className="browser-folder"
          data-testid="browser-folder-origin"
          type="button"
          aria-expanded={originOpen}
          onClick={() => setOriginOpen((open) => !open)}
        >
          {originOpen ? <ChevronDown size={14} strokeWidth={2.6} /> : <ChevronRight size={14} strokeWidth={2.6} />}
          {t("browser.origin")}
        </button>
        {originOpen ? (
          <ul className="browser-list">
            {(["xy", "xz", "yz"] as const).map((plane) => (
              <li className="browser-row origin-row" key={plane} style={{ paddingLeft: "22px" }}>
                <span className="browser-twisty placeholder" aria-hidden="true" />
                <span className="browser-name static" data-testid={`browser-plane-${plane}`}>
                  {t(`browser.plane.${plane}`)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <button
          className="browser-folder"
          data-testid="browser-folder-bodies"
          type="button"
          aria-expanded={bodiesOpen}
          onClick={() => setBodiesOpen((open) => !open)}
        >
          {bodiesOpen ? <ChevronDown size={14} strokeWidth={2.6} /> : <ChevronRight size={14} strokeWidth={2.6} />}
          {t("browser.bodies")}
          <span className="browser-count">{shapes.length}</span>
        </button>

        {bodiesOpen ? (
          shapes.length === 0 ? (
            <p className="browser-empty" data-testid="browser-empty">{t("browser.noBodies")}</p>
          ) : (
            <ul className="browser-list" data-testid="browser-bodies">
              {shapes.map((shape) => (
                <BodyRow
                  key={shape.id}
                  shape={shape}
                  depth={0}
                  selected={selectedIds.includes(shape.id)}
                  inheritedHidden={false}
                  expanded={expandedIds.includes(shape.id)}
                  onToggleExpanded={() =>
                    setExpandedIds((current) =>
                      current.includes(shape.id) ? current.filter((id) => id !== shape.id) : [...current, shape.id],
                    )
                  }
                  onSelect={selectBody}
                  onUpdateShape={onUpdateShape}
                  t={t}
                />
              ))}
            </ul>
          )
        ) : null}
      </div>

      {/*
        The resize grip. `separator` with an orientation and value range is what
        a screen reader needs to announce a draggable divider, and the arrow-key
        handler is what makes it usable without a pointer at all.
      */}
      <div
        className="browser-resize"
        data-testid="browser-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("browser.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_BROWSER_WIDTH}
        aria-valuemax={MAX_BROWSER_WIDTH}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onWidthChange(width - 16);
          else if (event.key === "ArrowRight") onWidthChange(width + 16);
          else return;
          event.preventDefault();
        }}
      />
    </aside>
  );
}
