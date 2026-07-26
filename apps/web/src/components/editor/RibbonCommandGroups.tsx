"use client";

import { commandsForTab, groupCommands, type EditorCommand, type RibbonTab } from "@/lib/commandRegistry";
import { useTranslation } from "@/lib/i18n";

/**
 * Renders one ribbon tab straight from the command registry.
 *
 * The Solid and Sketch tabs still have hand-built sections because they carry
 * widgets a plain button list cannot express — the shape gallery, the sketch
 * tool palette, the finish/cancel pair. Everything else is a list of commands,
 * and describing those twice is how a ribbon and its keyboard shortcuts drift
 * apart.
 */
export function RibbonCommandGroups({ commands, tab }: { commands: readonly EditorCommand[]; tab: RibbonTab }) {
  const { t } = useTranslation();
  const groups = groupCommands(commandsForTab(commands, tab));

  if (groups.length === 0) {
    return (
      <div className="tool-group left">
        <div className="toolbar-section">
          <div className="toolbar-section-label">{t(`tab.${tab}`)}</div>
          <div className="toolbar-section-tools ribbon-empty">{t("ribbon.empty")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="tool-group left">
      {groups.map((group) => (
        <div className="toolbar-section" key={group.groupKey}>
          <div className="toolbar-section-label">{t(group.groupKey)}</div>
          <div className="toolbar-section-tools">
            {group.commands.map((command) => {
              const label = t(command.labelKey);
              const Icon = command.icon;
              return (
                <button
                  key={command.id}
                  className={`toolbar-icon ${command.isEnabled ? "" : "disabled"} ${command.isActive ? "active" : ""}`}
                  data-testid={`tool-${command.id}`}
                  type="button"
                  aria-label={label}
                  title={label}
                  disabled={!command.isEnabled}
                  onClick={command.run}
                >
                  {Icon ? <Icon /> : <span className="toolbar-text-command">{label}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
