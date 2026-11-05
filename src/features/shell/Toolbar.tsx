import { useState } from "react";
import Button from "../../components/ui/Button";
import Menu, { type MenuItem } from "../../components/ui/Menu";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";

export default function Toolbar({
  onAddConnection,
  onImport,
  onExport,
  onToggleTree,
  onOpenWelcome,
  onOpenLog,
  onOpenSettings,
}: {
  onAddConnection: () => void;
  onImport: () => void;
  onExport: () => void;
  onToggleTree: () => void;
  onOpenWelcome: () => void;
  onOpenLog: () => void;
  onOpenSettings: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const t = useT();

  const menuItems: MenuItem[] = [
    { key: "import", label: t("toolbar.import"), icon: "import", onClick: onImport },
    { key: "export", label: t("toolbar.export"), icon: "export", onClick: onExport },
    {
      key: "toggle",
      label: t("toolbar.toggleTreeView"),
      shortcut: "Ctrl+Shift+E",
      icon: "sidebar",
      onClick: onToggleTree,
    },
    {
      key: "welcome",
      label: t("toolbar.welcome"),
      icon: "database",
      separatorBefore: true,
      onClick: onOpenWelcome,
    },
  ];

  return (
    <div className="relative flex h-[var(--ui-toolbar)] shrink-0 items-center gap-2 border-b border-border bg-win px-3">
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
          <Menu items={menuItems} onClose={() => setMenuOpen(false)} className="left-0 top-10" />
        ) : null}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        className="rounded-sm p-1.5 text-muted transition-colors hover:bg-base hover:text-text"
        title={t("toolbar.log")}
        onClick={onOpenLog}
      >
        <Icon name="log" />
      </button>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <button
        type="button"
        className="rounded-sm p-1.5 text-muted transition-colors hover:bg-base hover:text-text"
        title={t("toolbar.settings")}
        onClick={onOpenSettings}
      >
        <Icon name="settings" />
      </button>
    </div>
  );
}
