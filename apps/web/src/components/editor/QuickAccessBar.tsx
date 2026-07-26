"use client";

import { useEffect, useState } from "react";

import { LanguageSwitch } from "@/components/editor/LanguageSwitch";
import { ThemeSwitch } from "@/components/editor/ThemeSwitch";
import { ToolbarImportIcon, ToolbarSettingsIcon, ToolbarVectorExportIcon } from "@/components/icons";
import { useTranslation } from "@/lib/i18n";

/**
 * The quick access bar: import, export, settings, command search, language.
 *
 * These sit outside the ribbon tabs on purpose. Everything here is a way *out*
 * of being stuck — the command search most of all — and putting an escape hatch
 * behind a tab hides it exactly when someone needs it.
 */

/**
 * The command search shortcut, written the way this keyboard actually spells it.
 *
 * The editor listens for Ctrl+K everywhere and additionally Cmd+K on Apple
 * hardware, so a hard-coded "⌘K" is simply wrong on the Windows and Linux
 * machines this is mostly used on. Resolved after mount because the answer
 * comes from the browser, and the server has no keyboard to ask.
 */
function useCommandSearchShortcut() {
  const [label, setLabel] = useState("Ctrl K");

  useEffect(() => {
    const platform = navigator.userAgent;
    if (/Mac|iPhone|iPad|iPod/i.test(platform)) setLabel("⌘K");
  }, []);

  return label;
}

export type QuickAccessBarProps = {
  onImport: () => void;
  onExport: () => void;
  onWorkspaceSettings: () => void;
  onOpenCommandSearch: () => void;
};

export function QuickAccessBar({
  onImport,
  onExport,
  onWorkspaceSettings,
  onOpenCommandSearch,
}: QuickAccessBarProps) {
  const { t } = useTranslation();
  const shortcut = useCommandSearchShortcut();

  return (
    <div className="toolbar-section toolbar-actions-section">
      <div className="toolbar-section-label">{t("section.manage")}</div>
      <div className="action-buttons">
        <button
          className="action-icon-button"
          data-testid="quick-import"
          type="button"
          aria-label={t("tool.import")}
          title={t("tool.import")}
          onClick={onImport}
        >
          <ToolbarImportIcon />
        </button>
        <button
          className="action-icon-button"
          data-testid="quick-export"
          type="button"
          aria-label={t("tool.export")}
          title={t("tool.export")}
          onClick={onExport}
        >
          <ToolbarVectorExportIcon />
        </button>
        <button
          className="action-icon-button"
          data-testid="quick-workspace-settings"
          type="button"
          aria-label={t("tool.workspaceSettings")}
          title={t("tool.workspaceSettings")}
          onClick={onWorkspaceSettings}
        >
          <ToolbarSettingsIcon />
        </button>
        <button
          className="command-search-open"
          data-testid="command-search-open"
          type="button"
          aria-label={t("command.searchOpen")}
          title={t("command.searchOpen")}
          onClick={onOpenCommandSearch}
        >
          {shortcut}
        </button>
        <ThemeSwitch />
        <LanguageSwitch />
      </div>
    </div>
  );
}
