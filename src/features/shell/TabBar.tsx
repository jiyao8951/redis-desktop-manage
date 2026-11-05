import type { AppTab } from "../../App";
import { Icon, type IconName } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";

const TAB_ICON: Record<AppTab["kind"], IconName> = {
  welcome: "database",
  server: "server",
  key: "key",
  console: "terminal",
  "server-actions": "activity",
};

export default function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
}: {
  tabs: AppTab[];
  activeId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const t = useT();
  return (
    <div
      className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface"
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`group relative flex min-w-0 max-w-[220px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-[12px] transition-colors ${
              active ? "bg-base text-text" : "text-muted hover:bg-win hover:text-text"
            }`}
            onClick={() => onActivate(tab.id)}
            onAuxClick={(event) => {
              if (event.button === 1 && tab.closable) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            title={tab.kind === "welcome" ? t("app.tabWelcome") : tab.title}
            role="tab"
            aria-selected={active}
          >
            <span className={active ? "text-highlight" : "text-muted"}>
              <Icon name={TAB_ICON[tab.kind]} />
            </span>
            <span className="min-w-0 truncate">
              {tab.kind === "welcome" ? t("app.tabWelcome") : tab.title}
            </span>
            {tab.closable ? (
              <button
                type="button"
                className={`ml-1 shrink-0 rounded-sm p-0.5 text-muted transition-colors hover:bg-surface hover:text-text ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                aria-label={t("tabbar.closeTab", { title: tab.title })}
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
  );
}
