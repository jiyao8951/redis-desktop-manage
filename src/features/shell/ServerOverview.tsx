import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { useT } from "../../lib/i18n";
import type { ServerActionView, ServerFacts } from "../../lib/types";

/**
 * Landing page of a connection tab plus quick entries into every Server
 * Actions view (Server Info, Monitor Commands, Slow Log, Clients, Server Stats
 * and Console).
 */
export default function ServerOverview({
  name,
  facts,
  error,
  onOpenView,
}: {
  name: string;
  facts: ServerFacts | null;
  error: string | null;
  onOpenView: (view: ServerActionView) => void;
}) {
  const t = useT();

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-[420px] flex-col items-center gap-2 text-center t-14 text-danger">
          <Icon name="alert" className="h-5 w-5" />
          <div>{t("overview.error", { error })}</div>
        </div>
      </div>
    );
  }
  if (!facts) {
    return <div className="p-6 t-14 text-muted">{t("overview.loading")}</div>;
  }

  const rows: Array<[string, string]> = [
    [t("overview.name"), name],
    [t("overview.redisVersion"), facts.version],
    [t("overview.mode"), facts.redisMode],
    [t("overview.cluster"), facts.clusterEnabled ? t("overview.enabled") : t("overview.disabled")],
    [t("overview.databaseCount"), String(facts.configuredDatabases)],
    [t("overview.commandCount"), String(facts.commandCount)],
    [t("overview.modules"), facts.modules.length ? facts.modules.join(", ") : t("overview.none")],
  ];

  const views: Array<{ id: ServerActionView; label: Parameters<typeof t>[0] }> = [
    { id: "info", label: "server.view.info" },
    { id: "monitor", label: "server.view.monitor" },
    { id: "slowlog", label: "server.view.slowlog" },
    { id: "clients", label: "server.view.clients" },
    { id: "stats", label: "server.view.stats" },
    { id: "console", label: "server.view.console" },
  ];

  return (
    <div className="h-full overflow-auto bg-surface/20 p-6">
      <div className="mx-auto max-w-[820px] space-y-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-[var(--ui-control-lg)] w-[var(--ui-control-lg)] items-center justify-center rounded-md bg-surface text-muted">
            <Icon name="server" className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate t-17 font-semibold">{t("overview.title")}</h2>
            <div className="truncate font-mono t-12 text-muted">{name}</div>
          </div>
        </div>

        <section className="rounded-md border border-border bg-base p-4">
          <table className="w-full border-collapse t-content">
            <tbody>
              {rows.map(([label, value]) => (
                <tr key={label} className="border-b border-border last:border-b-0">
                  <td className="w-[190px] py-1.5 pr-4 text-muted">{label}</td>
                  <td className="py-1.5 font-mono text-text">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3 className="mb-2 t-13 font-semibold uppercase tracking-wide text-muted">
            {t("overview.quickActions")}
          </h3>
          <div className="flex flex-wrap gap-2">
            {views.map((view) => (
              <Button key={view.id} variant="secondary" onClick={() => onOpenView(view.id)}>
                {t(view.label)}
              </Button>
            ))}
          </div>
        </section>

        <section className="rounded-md border border-border bg-base p-4">
          <h3 className="mb-2 t-13 font-semibold uppercase tracking-wide text-muted">
            {t("overview.databases")}
          </h3>
          {facts.keyspace.length ? (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-1 t-content sm:grid-cols-3">
              {facts.keyspace.map((db) => (
                <li key={db.index} className="flex items-center justify-between gap-2">
                  <span className="font-mono">db{db.index}</span>
                  <span className="text-muted">{t("overview.keyCount", { count: db.keys })}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-content text-muted">{t("overview.noKeys")}</p>
          )}
        </section>
      </div>
    </div>
  );
}
