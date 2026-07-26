"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, searchableCommands, type EditorCommand } from "@/lib/commandRegistry";
import { useTranslation } from "@/lib/i18n";

/**
 * Type-ahead access to every command.
 *
 * A ribbon has to hide things behind tabs to stay legible, which makes rarely
 * used commands hard to reach. This is the escape hatch: press Ctrl+K, type a
 * few letters, press Enter. It also happens to be how a beginner discovers what
 * the application can do without hunting through five tabs.
 */
export function CommandSearch({
  commands,
  open,
  onOpenChange,
}: {
  commands: readonly EditorCommand[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const entries = useMemo(() => searchableCommands(commands, t), [commands, t]);
  const results = useMemo(() => filterCommands(entries, query), [entries, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlighted(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  if (!open) return null;

  const choose = (command: EditorCommand | undefined) => {
    if (!command?.isEnabled) return;
    onOpenChange(false);
    command.run();
  };

  return (
    <div
      className="command-search-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className="command-search" role="dialog" aria-modal="true" aria-label={t("command.searchTitle")}>
        <input
          ref={inputRef}
          data-testid="command-search-input"
          className="command-search-input"
          type="text"
          role="combobox"
          aria-expanded
          aria-controls="command-search-results"
          aria-activedescendant={results[highlighted] ? `command-result-${results[highlighted].command.id}` : undefined}
          placeholder={t("command.searchPlaceholder")}
          aria-label={t("command.searchTitle")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results[highlighted]?.command);
            } else if (event.key === "Escape") {
              event.preventDefault();
              // Stop here rather than letting Escape reach the editor's global
              // handler, which would also clear the selection.
              event.stopPropagation();
              onOpenChange(false);
            }
          }}
        />

        <ul className="command-search-results" id="command-search-results" role="listbox" data-testid="command-search-results">
          {results.map((entry, index) => (
            <li
              key={entry.command.id}
              id={`command-result-${entry.command.id}`}
              role="option"
              aria-selected={index === highlighted}
              aria-disabled={!entry.command.isEnabled}
            >
              <button
                type="button"
                data-testid={`command-result-${entry.command.id}`}
                className={`command-search-result ${index === highlighted ? "highlighted" : ""}`}
                disabled={!entry.command.isEnabled}
                onPointerEnter={() => setHighlighted(index)}
                onClick={() => choose(entry.command)}
              >
                <span className="command-search-label">{entry.label}</span>
                <span className="command-search-group">{t(entry.command.groupKey)}</span>
                {entry.command.shortcut ? <kbd>{entry.command.shortcut}</kbd> : null}
              </button>
            </li>
          ))}
          {results.length === 0 ? (
            <li className="command-search-empty" role="option" aria-selected={false} aria-disabled>
              {t("command.searchEmpty")}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
