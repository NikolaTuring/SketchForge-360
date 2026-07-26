import { describe, expect, it } from "vitest";

import { CONTEXT_MENU_GROUPS, contextMenuGroups, type EditorCommand } from "@/lib/commandRegistry";

/**
 * The context menu's editing rules.
 *
 * The menu is a shortlist over the same registry the ribbon uses, so what is
 * worth testing is the editing: which entries survive the current selection,
 * and that the separators never outlive the group they were separating.
 */

function command(id: string, isEnabled: boolean): EditorCommand {
  return { id, labelKey: "tool.copy", tab: "solid", groupKey: "section.home", run: () => {}, isEnabled };
}

function registry(enabled: readonly string[]): EditorCommand[] {
  return CONTEXT_MENU_GROUPS.flat().map((id) => command(id, enabled.includes(id)));
}

describe("context menu", () => {
  it("keeps only what applies right now", () => {
    const groups = contextMenuGroups(registry(["copy", "delete"]));
    expect(groups.flat().map((entry) => entry.id)).toEqual(["copy", "delete"]);
  });

  it("drops a group whose entries all fell away", () => {
    // Two separate groups in the source list, one entry each surviving: the
    // result must be two groups, not five with three empty.
    const groups = contextMenuGroups(registry(["duplicate", "fillet"]));
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.length > 0)).toBe(true);
  });

  it("is empty when nothing applies", () => {
    expect(contextMenuGroups(registry([]))).toEqual([]);
  });

  it("keeps the declared order", () => {
    const groups = contextMenuGroups(registry(["delete", "copy", "fillet"]));
    expect(groups.flat().map((entry) => entry.id)).toEqual(["copy", "fillet", "delete"]);
  });

  it("ignores ids the registry does not carry", () => {
    // The menu names commands by id; one going missing from the registry must
    // shorten the menu, not crash it.
    expect(contextMenuGroups([command("copy", true)]).flat().map((entry) => entry.id)).toEqual(["copy"]);
  });

  it("names no command twice", () => {
    const ids = CONTEXT_MENU_GROUPS.flat();
    expect(new Set(ids).size).toBe(ids.length);
  });
});
