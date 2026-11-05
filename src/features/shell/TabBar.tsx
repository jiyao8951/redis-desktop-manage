import { useState } from "react";

import type { AppTab } from "../../App";
import { Icon, type IconName } from "../../components/ui/Icon";
import Menu, { type MenuItem } from "../../components/ui/Menu";
import { useT } from "../../lib/i18n";

const TAB_ICON: Record<AppTab["kind"], IconName> = {
  welcome: "database",
  server: "server",
  key: "key",
  console: "terminal",
  "server-actions": "activity",
};

interface TabMenuState {
  tabId: string;
  x: number;
  y: number;
}

export default function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
  onDisconnect,
}: {
  tabs: AppTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseRight: (id: string) => void;
  onCloseAll: () => void;
  onDisconnect: (id: string) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const target = menu ? tabs.find((tab) => tab.id === menu.tabId) : undefined;

  const items: MenuItem[] = target
    ? [
        {
          key: "close",
          label: t("tabbar.close"),
          icon: "x",
          disabled: !target.closable,
          onClick: () => onClose(target.id),
        },
        {
          key: "others",
          label: t("tabbar.closeOthers"),
          onClick: () => onCloseOthers(target.id),
        },
        {
          key: "right",
          label: t("tabbar.closeRight"),
          icon: "chevron-right",
          onClick: () => onCloseRight(target.id),
        },
        {
          key: "all",
          label: t("tabbar.closeAll"),
          icon: "trash",
          onClick: onCloseAll,
        },
        ...(target.connectionId !== undefined
          ? [
              {
                key: "disconnect",
                label: t("tabbar.closeConnection"),
                icon: "unload" as IconName,
                danger: true,
                separatorBefore: true,
                onClick: () => onDisconnect(target.id),
              },
            ]
          : []),
      ]
    : [];

  // Anchor the menu to the cursor while keeping it inside the viewport.
  const menuWidth = 248;
  const menuHeight = items.length * 36 + (target?.connectionId !== undefined ? 9 : 0) + 10;
  const left = menu ? Math.max(8, Math.min(menu.x, window.innerWidth - menuWidth - 8)) : 0;
  const top = menu ? Math.max(8, Math.min(menu.y, window.innerHeight - menuHeight - 8)) : 0;

  return (
    <>
      <div
        className="flex h-[var(--ui-tabbar)] shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface"
        role="tablist"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const title = tab.kind === "welcome" ? t("app.tabWelcome") : tab.title;
          return (
            <div
              key={tab.id}
              className={`group relative flex min-w-0 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 t-13 transition-colors ${
                active ? "bg-base text-text" : "text-muted hover:bg-win hover:text-text"
              }`}
              onClick={() => {
                setMenu(null);
                onActivate(tab.id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1 && tab.closable) {
                  event.preventDefault();
                  setMenu(null);
                  onClose(tab.id);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
              }}
              title={title}
              role="tab"
              aria-selected={active}
            >
              <span className={active ? "text-highlight" : "text-muted"}>
                <Icon name={TAB_ICON[tab.kind]} />
              </span>
              <span className="min-w-0 truncate">{title}</span>
              {tab.closable ? (
                <button
                  type="button"
                  className={`ml-1 shrink-0 rounded-sm p-0.5 text-muted transition-colors hover:bg-surface hover:text-text ${
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(null);
                    onClose(tab.id);
                  }}
                  aria-label={t("tabbar.closeTab", { title })}
                >
                  <Icon name="x" />
                </button>
              ) : null}
              {active ? (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" aria-hidden="true" />
              ) : null}
            </div>
          );
        })}
      </div>
      {menu && target ? (
        <Menu
          items={items}
          onClose={() => setMenu(null)}
          style={{ position: "fixed", left, top, width: menuWidth }}
        />
      ) : null}
    </>
  );
}
