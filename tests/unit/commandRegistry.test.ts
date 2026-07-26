import { describe, expect, it, vi } from "vitest";
import {
  RIBBON_TABS,
  commandsForTab,
  filterCommands,
  findCommand,
  groupCommands,
  normalizeSearchText,
  runCommand,
  scoreCommand,
  searchableCommands,
  type EditorCommand,
} from "@/lib/commandRegistry";
import type { TranslationKey, Translator } from "@/lib/i18n";

function command(overrides: Partial<EditorCommand> & Pick<EditorCommand, "id">): EditorCommand {
  return {
    labelKey: "tool.copy",
    tab: "solid",
    groupKey: "section.clipboard",
    run: () => {},
    isEnabled: true,
    ...overrides,
  };
}

/** Stands in for the real translator: keys map to their own last segment. */
const t: Translator = (key: TranslationKey) => String(key).split(".").pop() ?? String(key);

describe("normalizeSearchText", () => {
  it("folds case and strips diacritics so ASCII typing reaches German labels", () => {
    expect(normalizeSearchText("Löschen")).toBe("loschen");
    expect(normalizeSearchText("Gruppierung AUFHEBEN")).toBe("gruppierung aufheben");
    expect(normalizeSearchText("Maß")).toBe("mass");
  });
});

describe("scoreCommand", () => {
  it("ranks a prefix above a word start above a match anywhere", () => {
    const prefix = scoreCommand("Delete", "del");
    const wordStart = scoreCommand("Drop to workplane", "work");
    const anywhere = scoreCommand("Boolean Intersection", "ersect");

    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(anywhere);
    expect(anywhere).toBeGreaterThan(0);
  });

  it("prefers a shorter label for the same prefix", () => {
    expect(scoreCommand("Group", "group")).toBeGreaterThan(scoreCommand("Group selection into one", "group"));
  });

  it("matches everything when the query is empty", () => {
    expect(scoreCommand("anything", "")).toBe(1);
    expect(scoreCommand("anything", "   ")).toBe(1);
  });

  it("returns zero when nothing matches", () => {
    expect(scoreCommand("Delete", "zzz")).toBe(0);
  });

  it("does not choke on regular-expression characters in the query", () => {
    expect(() => scoreCommand("Delete", "a(b[c")).not.toThrow();
    expect(scoreCommand("Delete", "a(b[c")).toBe(0);
  });
});

describe("filterCommands", () => {
  const commands = [
    command({ id: "delete", labelKey: "tool.delete" }),
    command({ id: "duplicate", labelKey: "tool.duplicate" }),
    command({ id: "group", labelKey: "tool.group" }),
    command({ id: "ungroup", labelKey: "tool.ungroup" }),
    command({ id: "fillet", labelKey: "tool.fillet", isEnabled: false }),
  ];
  const entries = searchableCommands(commands, t);

  it("ranks the closest match first", () => {
    expect(filterCommands(entries, "del")[0].command.id).toBe("delete");
    expect(filterCommands(entries, "ungr")[0].command.id).toBe("ungroup");
  });

  it("keeps disabled commands visible so the user learns why nothing happened", () => {
    const results = filterCommands(entries, "fillet");
    expect(results.map((entry) => entry.command.id)).toContain("fillet");
  });

  it("puts enabled commands ahead of disabled ones at the same score", () => {
    const tied = searchableCommands(
      [
        command({ id: "off", labelKey: "tool.copy", isEnabled: false }),
        command({ id: "on", labelKey: "tool.copy", isEnabled: true }),
      ],
      t,
    );
    expect(filterCommands(tied, "copy")[0].command.id).toBe("on");
  });

  it("matches on keywords as well as the label, but ranks them lower", () => {
    const withKeywords = searchableCommands(
      [
        command({ id: "intersect", labelKey: "tool.intersect", keywordsKey: "tool.chamfer" }),
        command({ id: "chamfer", labelKey: "tool.chamfer" }),
      ],
      t,
    );
    const results = filterCommands(withKeywords, "chamfer");
    expect(results.map((entry) => entry.command.id)).toEqual(["chamfer", "intersect"]);
  });

  it("omits hidden commands entirely", () => {
    const hidden = searchableCommands([command({ id: "secret", labelKey: "tool.copy", hidden: true })], t);
    expect(filterCommands(hidden, "copy")).toHaveLength(0);
  });

  it("returns everything, capped, for an empty query", () => {
    expect(filterCommands(entries, "")).toHaveLength(commands.length);
    expect(filterCommands(entries, "", 2)).toHaveLength(2);
  });
});

describe("tabs and groups", () => {
  const commands = [
    command({ id: "copy", tab: "solid", groupKey: "section.clipboard" }),
    command({ id: "paste", tab: "solid", groupKey: "section.clipboard" }),
    command({ id: "group", tab: "solid", groupKey: "section.combine" }),
    command({ id: "measure", tab: "inspect", groupKey: "section.inspect" }),
  ];

  it("selects a tab's commands", () => {
    expect(commandsForTab(commands, "solid").map((entry) => entry.id)).toEqual(["copy", "paste", "group"]);
    expect(commandsForTab(commands, "mesh")).toEqual([]);
  });

  it("groups in registration order and keeps members together", () => {
    const groups = groupCommands(commandsForTab(commands, "solid"));
    expect(groups.map((group) => group.groupKey)).toEqual(["section.clipboard", "section.combine"]);
    expect(groups[0].commands.map((entry) => entry.id)).toEqual(["copy", "paste"]);
  });

  it("declares every tab used by a command", () => {
    commands.forEach((entry) => expect(RIBBON_TABS).toContain(entry.tab));
  });
});

describe("runCommand", () => {
  it("runs an enabled command", () => {
    const run = vi.fn();
    const commands = [command({ id: "copy", run })];
    expect(runCommand(commands, "copy")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a disabled command, so every entry point agrees", () => {
    const run = vi.fn();
    const commands = [command({ id: "copy", run, isEnabled: false })];
    expect(runCommand(commands, "copy")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores an unknown id", () => {
    expect(runCommand([], "nope")).toBe(false);
    expect(findCommand([], "nope")).toBeUndefined();
  });
});
