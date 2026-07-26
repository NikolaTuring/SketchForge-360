// The editor's command registry.
//
// Every ribbon button, context-menu entry and keyboard shortcut names the same
// command, so its label, its availability and what it does are declared once.
// Before this, a command's enabled-state lived in the render, its label in a
// tool array and its keyboard binding in a separate switch — three places that
// could and did drift apart.
//
// The registry itself is assembled in the editor, which owns the handlers. This
// module holds the shape of a command and the pure functions over a list of
// them, so the searching, grouping and filtering can be tested without a DOM.

import type { ReactElement } from "react";
import type { TranslationKey, Translator } from "@/lib/i18n";

/** Ribbon tabs, in display order. */
export const RIBBON_TABS = ["solid", "sketch", "mesh", "inspect", "utilities"] as const;
export type RibbonTab = (typeof RIBBON_TABS)[number];

export type EditorCommand = {
  /** Stable and machine-facing: tests, shortcuts and menus all key off this. */
  id: string;
  labelKey: TranslationKey;
  /** Ribbon tab this command belongs to. */
  tab: RibbonTab;
  /** Heading of the group it sits under within that tab. */
  groupKey: TranslationKey;
  icon?: (props: { className?: string }) => ReactElement;
  run: () => void;
  isEnabled: boolean;
  isActive?: boolean;
  /** Shown in the command search; purely informational. */
  shortcut?: string;
  /** Extra search terms, so "hole" finds the boolean tools. */
  keywordsKey?: TranslationKey;
  /** Keep out of the command search (separators, duplicates of another entry). */
  hidden?: boolean;
};

/**
 * Folds case and strips diacritics so a German label is reachable from an ASCII
 * keyboard — typing "loschen" has to find "Löschen", and "ausrichten" has to
 * find "Ausrichten" regardless of capitalisation.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    // Combining diacritical marks, written as escapes so the source stays
    // readable and cannot be mangled by an editor normalising the file.
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .trim();
}

/**
 * Scores a command against a query. Higher is better; zero means no match.
 *
 * A prefix match outranks a word-start match, which outranks a match anywhere,
 * so typing "del" puts Delete above "Drop to workplane" even though both
 * contain the letters.
 */
export function scoreCommand(haystack: string, query: string): number {
  if (!query) return 1;
  const text = normalizeSearchText(haystack);
  const needle = normalizeSearchText(query);
  if (!needle) return 1;

  if (text.startsWith(needle)) return 100 - Math.min(50, text.length - needle.length);
  const wordStart = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (wordStart.test(text)) return 60;
  if (text.includes(needle)) return 30;
  return 0;
}

export type SearchableCommand = { command: EditorCommand; label: string; keywords: string };

export function searchableCommands(commands: readonly EditorCommand[], t: Translator): SearchableCommand[] {
  return commands
    .filter((command) => !command.hidden)
    .map((command) => ({
      command,
      label: t(command.labelKey),
      keywords: command.keywordsKey ? t(command.keywordsKey) : "",
    }));
}

/**
 * Matches, ranked. Disabled commands still appear — hiding them makes the search
 * feel broken when a command exists but the selection is wrong, and a greyed-out
 * result tells the user why nothing happened.
 */
export function filterCommands(entries: readonly SearchableCommand[], query: string, limit = 12): SearchableCommand[] {
  return entries
    .map((entry) => ({
      entry,
      score: Math.max(scoreCommand(entry.label, query), scoreCommand(entry.keywords, query) * 0.8),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Enabled commands first, then alphabetically, so the order is stable.
      if (a.entry.command.isEnabled !== b.entry.command.isEnabled) return a.entry.command.isEnabled ? -1 : 1;
      return a.entry.label.localeCompare(b.entry.label);
    })
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function commandsForTab(commands: readonly EditorCommand[], tab: RibbonTab): EditorCommand[] {
  return commands.filter((command) => command.tab === tab);
}

export type CommandGroup = { groupKey: TranslationKey; commands: EditorCommand[] };

/** Groups a tab's commands, preserving the order in which they were registered. */
export function groupCommands(commands: readonly EditorCommand[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  commands.forEach((command) => {
    const existing = groups.find((group) => group.groupKey === command.groupKey);
    if (existing) existing.commands.push(command);
    else groups.push({ groupKey: command.groupKey, commands: [command] });
  });
  return groups;
}

export function findCommand(commands: readonly EditorCommand[], id: string): EditorCommand | undefined {
  return commands.find((command) => command.id === id);
}

/**
 * Runs a command by id, but only when it is currently available.
 *
 * Every entry point — ribbon, context menu, search, keyboard — goes through
 * this, so a disabled command cannot be triggered from one route while being
 * greyed out in another.
 */
export function runCommand(commands: readonly EditorCommand[], id: string): boolean {
  const command = findCommand(commands, id);
  if (!command?.isEnabled) return false;
  command.run();
  return true;
}
