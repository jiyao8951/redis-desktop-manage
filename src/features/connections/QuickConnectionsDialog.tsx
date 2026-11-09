import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";
import type { ConnectionSummary } from "../../lib/types";
import type { RecentConnection } from "../tree/treePrefs";

export type QuickConnectionsMode = "recent" | "favorites";

/**
 * Quick entry point for the "Recent" and "Favorites" connection lists.
 * Entries whose connection no longer exists are silently skipped.
 */
export default function QuickConnectionsDialog({
  mode,
  connections,
  favorites,
  recent,
  onOpen,
  onClose,
}: {
  mode: QuickConnectionsMode;
  connections: ConnectionSummary[];
  favorites: Set<string>;
  recent: RecentConnection[];
  onOpen: (connection: ConnectionSummary) => void;
  onClose: () => void;
}) {
  const t = useT();

  const items: ConnectionSummary[] =
    mode === "favorites"
      ? connections
          .filter((connection) => favorites.has(connection.id))
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
      : recent
          .map((entry) => connections.find((connection) => connection.id === entry.id))
          .filter((connection): connection is ConnectionSummary => Boolean(connection));

  return (
    <Dialog
      title={mode === "favorites" ? t("quick.favoritesTitle") : t("quick.recentTitle")}
      width={520}
      onClose={onClose}
      footer={<Button onClick={onClose}>{t("common.close")}</Button>}
    >
      {items.length ? (
        <ul className="space-y-1">
          {items.map((connection) => (
            <li key={connection.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm border border-border bg-surface/40 px-2.5 py-2 text-left t-13 transition-colors hover:border-highlight/60 hover:bg-surface"
                onClick={() => onOpen(connection)}
              >
                <span className="text-muted">
                  <Icon name={mode === "favorites" ? "star-filled" : "server"} />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{connection.name}</span>
                <span className="shrink-0 font-mono t-12 text-muted">
                  {connection.host}:{connection.port}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="t-13 text-muted">
          {mode === "favorites" ? t("quick.favoritesEmpty") : t("quick.recentEmpty")}
        </p>
      )}
    </Dialog>
  );
}
