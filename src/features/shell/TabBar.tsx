import type { AppTab } from "../../App";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";

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
    <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-surface">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={`group flex max-w-[220px] cursor-pointer items-center gap-1.5 border-r border-border px-3 text-[12px] ${
              active ? "bg-base text-text" : "text-muted hover:bg-win"
            }`}
            onClick={() => onActivate(tab.id)}
            role="tab"
            aria-selected={active}
          >
            {tab.kind === "welcome" ? (
              <span className="text-accent">◆</span>
            ) : (
              <Icon name="database" />
            )}
            <span className="truncate">
              {tab.kind === "welcome" ? t("app.tabWelcome") : tab.title}
            </span>
            {tab.closable ? (
              <button
                type="button"
                className="ml-1 rounded-sm px-0.5 opacity-40 hover:bg-surface hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                aria-label={t("tabbar.closeTab", { title: tab.title })}
              >
                <Icon name="x" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
