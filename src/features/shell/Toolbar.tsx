import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Button from "../../components/ui/Button";
import Menu, { type MenuItem } from "../../components/ui/Menu";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";

export default function Toolbar({
  onAddConnection,
  onImport,
  onExport,
  onToggleTree,
  onOpenLog,
  onOpenSettings,
}: {
  onAddConnection: () => void;
  onImport: () => void;
  onExport: () => void;
  onToggleTree: () => void;
  onOpenLog: () => void;
  onOpenSettings: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const t = useT();

  const menuItems: MenuItem[] = [
    { key: "import", label: t("toolbar.import"), icon: "plus", onClick: onImport },
    { key: "export", label: t("toolbar.export"), icon: "copy", onClick: onExport },
    {
      key: "toggle",
      label: t("toolbar.toggleTreeView"),
      shortcut: "Ctrl+Shift+E",
      icon: "eye",
      onClick: onToggleTree,
    },
  ];

  return (
    <div className="relative flex h-11 shrink-0 items-center gap-2 border-b border-border bg-win px-3">
      <div className="relative flex">
        <Button variant="primary" className="rounded-r-none" onClick={onAddConnection}>
          <Icon name="plus" />
          {t("toolbar.connect")}
        </Button>
        <Button
          variant="primary"
          className="rounded-l-none border-l-white/25 px-1.5"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={t("toolbar.connectionMenu")}
        >
          <Icon name="chevron-down" />
        </Button>
        {menuOpen ? (
          <Menu items={menuItems} onClose={() => setMenuOpen(false)} className="left-0 top-9" />
        ) : null}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        className="rounded-sm p-1.5 text-muted hover:bg-surface hover:text-text"
        title={t("toolbar.help")}
        onClick={() => void openUrl("https://docs.resp.app/")}
      >
        <Icon name="search" />
      </button>
      <button
        type="button"
        className="rounded-sm p-1.5 text-muted hover:bg-surface hover:text-text"
        title={t("toolbar.log")}
        onClick={onOpenLog}
      >
        <Icon name="log" />
      </button>
      <button
        type="button"
        className="rounded-sm p-1.5 text-muted hover:bg-surface hover:text-text"
        title={t("toolbar.extensionServer")}
        onClick={onOpenSettings}
      >
        <Icon name="lock" />
      </button>
      <button
        type="button"
        className="rounded-sm p-1.5 text-muted hover:bg-surface hover:text-text"
        title={t("toolbar.settings")}
        onClick={onOpenSettings}
      >
        <Icon name="settings" />
      </button>
    </div>
  );
}
