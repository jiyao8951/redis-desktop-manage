import Button from "../../components/ui/Button";
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
    return <div className="p-6 text-[13px] text-danger">{t("overview.error", { error })}</div>;
  }
  if (!facts) {
    return <div className="p-6 text-[13px] text-muted">{t("overview.loading")}</div>;
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
    <div className="h-full overflow-auto p-6">
      <h2 className="mb-3 text-[18px]">{t("overview.title")}</h2>
      <table className="min-w-[420px] border-collapse text-[12px]">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-border">
              <td className="w-[190px] py-1.5 pr-4 text-muted">{label}</td>
              <td className="py-1.5 font-mono">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mb-2 mt-6 text-[14px]">{t("overview.quickActions")}</h3>
      <div className="flex flex-wrap gap-2">
        {views.map((view) => (
          <Button key={view.id} variant="secondary" onClick={() => onOpenView(view.id)}>
            {t(view.label)}
          </Button>
        ))}
      </div>

      <h3 className="mb-2 mt-6 text-[14px]">{t("overview.databases")}</h3>
      {facts.keyspace.length ? (
        <ul className="space-y-1 text-[12px]">
          {facts.keyspace.map((db) => (
            <li key={db.index}>
              db{db.index}: {t("overview.keyCount", { count: db.keys })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-muted">{t("overview.noKeys")}</p>
      )}
    </div>
  );
}
