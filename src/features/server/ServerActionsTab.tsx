import { useCallback, useEffect, useRef, useState } from "react";

import Button from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/fields";
import { errMessage } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ipc } from "../../lib/ipc";
import type {
  ClientEntry,
  ConfigEntry,
  MemoryReport,
  ServerActionView,
  ServerInfo,
  SlowlogEntry,
} from "../../lib/types";
import ConsoleTab from "../console/ConsoleTab";
import MonitorPanel from "./MonitorPanel";
import StatsChart, { type StatsPoint } from "./StatsChart";

interface ServerActionsTabProps {
  connectionId: string;
  connectionName: string;
  initialView: ServerActionView;
  onNotify: (message: string) => void;
  onLog: (message: string, level?: "info" | "error") => void;
}

const VIEWS: {
  id: ServerActionView;
  label:
    | "server.view.stats"
    | "server.view.info"
    | "server.view.slowlog"
    | "server.view.clients"
    | "server.view.monitor"
    | "server.view.console"
    | "server.view.config"
    | "server.view.memory";
  refreshable: boolean;
}[] = [
  { id: "info", label: "server.view.info", refreshable: true },
  { id: "monitor", label: "server.view.monitor", refreshable: false },
  { id: "slowlog", label: "server.view.slowlog", refreshable: true },
  { id: "clients", label: "server.view.clients", refreshable: true },
  { id: "stats", label: "server.view.stats", refreshable: true },
  { id: "console", label: "server.view.console", refreshable: false },
  { id: "config", label: "server.view.config", refreshable: false },
  { id: "memory", label: "server.view.memory", refreshable: false },
];

const REFRESH_INTERVAL = 5000;
/** qmlutils.cpp MAX_CHART_DATA_POINTS. */
const MAX_DATA_POINTS = 1000;

interface StatsSample {
  t: number;
  values: Record<string, number>;
}

function sectionValue(info: ServerInfo | null, section: string, field: string): string {
  const block = info?.sections.find((item) => item.name.toLowerCase() === section);
  return block?.fields.find((item) => item.name === field)?.value ?? "";
}

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function chartPoint(samples: StatsSample[], key: string): StatsPoint[] {
  return samples.map((sample) => ({ t: sample.t, v: sample.values[key] ?? 0 }));
}

function DataTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const t = useT();
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {rows.length === 0 ? (
        <div className="p-3 text-[12px] text-muted">{t("server.noData")}</div>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-surface text-muted">
            <tr>
              {columns.map((column) => (
                <th key={column} className="border-b border-border px-2 py-1 text-left font-normal">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-surface">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border-b border-border px-2 py-0.5 align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function ServerActionsTab({
  connectionId,
  connectionName,
  initialView,
  onNotify,
  onLog,
}: ServerActionsTabProps) {
  const t = useT();
  const [view, setView] = useState<ServerActionView>(initialView);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [slowlog, setSlowlog] = useState<SlowlogEntry[]>([]);
  const [clients, setClients] = useState<ClientEntry[]>([]);
  const [config, setConfig] = useState<ConfigEntry[]>([]);
  const [memory, setMemory] = useState<MemoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [samples, setSamples] = useState<StatsSample[]>([]);

  const seq = useRef(0);
  const logRef = useRef(onLog);
  logRef.current = onLog;

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  const load = useCallback(async () => {
    const ticket = (seq.current += 1);
    setLoading(true);
    setError(null);
    try {
      if (view === "stats" || view === "info") {
        const data = await ipc.serverInfo(connectionId);
        if (seq.current !== ticket) return;
        setInfo(data);
        const sample: StatsSample = {
          t: Date.now(),
          values: {
            ops: numeric(sectionValue(data, "stats", "instantaneous_ops_per_sec")),
            clients: numeric(sectionValue(data, "clients", "connected_clients")),
            memoryMb: numeric(sectionValue(data, "memory", "used_memory")) / (1024 * 1024),
            inputKbps: numeric(sectionValue(data, "stats", "instantaneous_input_kbps")),
            outputKbps: numeric(sectionValue(data, "stats", "instantaneous_output_kbps")),
            errors: numeric(sectionValue(data, "stats", "total_error_replies")),
          },
        };
        setSamples((prev) => {
          const next = [...prev, sample];
          return next.length > MAX_DATA_POINTS ? next.slice(next.length - MAX_DATA_POINTS) : next;
        });
      } else if (view === "slowlog") {
        const rows = await ipc.serverSlowlog(connectionId);
        if (seq.current !== ticket) return;
        setSlowlog(rows);
      } else if (view === "clients") {
        const rows = await ipc.serverClients(connectionId);
        if (seq.current !== ticket) return;
        setClients(rows);
      } else if (view === "config") {
        const rows = await ipc.serverConfigGet(connectionId);
        if (seq.current !== ticket) return;
        setConfig(rows);
      } else if (view === "memory") {
        const report = await ipc.serverMemory(connectionId);
        if (seq.current !== ticket) return;
        setMemory(report);
      }
    } catch (e) {
      if (seq.current !== ticket) return;
      const message = errMessage(e);
      setError(message);
      logRef.current(`${connectionName}: ${message}`, "error");
    } finally {
      if (seq.current === ticket) setLoading(false);
    }
  }, [connectionId, connectionName, view]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refreshable = VIEWS.find((item) => item.id === view)?.refreshable ?? false;
    if (!autoRefresh || !refreshable) return;
    const timer = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load, view]);

  const sections = info?.sections ?? [];
  const activeSection = sections[Math.min(sectionIndex, Math.max(0, sections.length - 1))];

  const charts: {
    title: Parameters<typeof t>[0];
    unit: string;
    kind: "line" | "spline";
    key: string;
    initialMax?: number;
  }[] = [
    {
      title: "chart.ops",
      unit: t("chart.unitOps"),
      kind: "line",
      key: "ops",
      initialMax: 100,
    },
    {
      title: "chart.clients",
      unit: t("chart.unitClients"),
      kind: "spline",
      key: "clients",
      initialMax: 100,
    },
    {
      title: "chart.memory",
      unit: t("chart.unitMb"),
      kind: "spline",
      key: "memoryMb",
    },
    { title: "chart.networkInput", unit: t("chart.unitKbps"), kind: "line", key: "inputKbps" },
    { title: "chart.networkOutput", unit: t("chart.unitKbps"), kind: "line", key: "outputKbps" },
    {
      title: "chart.errors",
      unit: t("chart.unitErrors"),
      kind: "line",
      key: "errors",
      initialMax: 100,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col bg-base">
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface/40 px-3 py-1.5">
        <span className="mr-1 text-[12px] font-semibold text-text">{t("server.title")}</span>
        <div className="flex flex-wrap items-center gap-0.5 rounded-sm border border-border bg-surface p-0.5">
          {VIEWS.map((item) => (
            <Button
              key={item.id}
              variant={view === item.id ? "secondary" : "ghost"}
              className={view === item.id ? "shadow-sm" : ""}
              onClick={() => setView(item.id)}
            >
              {t(item.label)}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Checkbox
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label={<span className="text-[11px] text-muted">{t("server.autoRefresh")}</span>}
          />
          <Button variant="secondary" disabled={loading} onClick={() => void load()}>
            {t("server.refresh")}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-muted">
        <span className="font-mono">{connectionName}</span>
        {loading ? <span>{t("server.loading")}</span> : null}
        {view === "config" ? <span>{t("server.configHint")}</span> : null}
      </div>

      {error ? (
        <div className="border-b border-border bg-danger/5 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      ) : null}

      {view === "stats" ? (
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-2">
          {charts.map((chart) => (
            <StatsChart
              key={chart.key}
              title={t(chart.title)}
              unit={chart.unit}
              kind={chart.kind}
              initialMax={chart.initialMax}
              points={chartPoint(samples, chart.key)}
            />
          ))}
        </div>
      ) : null}

      {view === "info" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1.5">
            {sections.map((section, index) => (
              <Button
                key={section.name}
                variant={index === sectionIndex ? "secondary" : "ghost"}
                onClick={() => setSectionIndex(index)}
              >
                {section.name}
              </Button>
            ))}
          </div>
          {activeSection ? (
            <DataTable
              columns={[t("server.property"), t("common.value")]}
              rows={activeSection.fields.map((field) => [field.name, field.value])}
            />
          ) : (
            <div className="p-3 text-[12px] text-muted">{t("server.infoNoSections")}</div>
          )}
        </div>
      ) : null}

      {view === "slowlog" ? (
        <DataTable
          columns={[t("server.command"), t("server.processedAt"), t("server.executionTime")]}
          rows={slowlog.map((entry) => [
            entry.command.join(" "),
            new Date(entry.time * 1000).toLocaleString(),
            String(entry.durationUs),
          ])}
        />
      ) : null}

      {view === "clients" ? (
        <DataTable
          columns={[
            t("server.clientAddress"),
            t("server.clientName"),
            t("server.clientAge"),
            t("server.clientIdle"),
            t("server.clientFlags"),
            t("server.clientDb"),
            t("server.clientLastCommand"),
          ]}
          rows={clients.map((client) => [
            client.addr,
            client.name,
            client.age,
            client.idle,
            client.flags,
            client.db,
            client.cmd,
          ])}
        />
      ) : null}

      {view === "config" ? (
        <DataTable
          columns={[t("server.directive"), t("common.value")]}
          rows={config.map((entry) => [entry.name, entry.value])}
        />
      ) : null}

      {view === "memory" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border px-3 py-2 text-[12px] text-text">
            <div className="text-[11px] text-muted">{t("server.memoryDoctor")}</div>
            <div className="mt-1 whitespace-pre-wrap">
              {memory?.doctor?.trim() || t("server.memoryNoVerdict")}
            </div>
          </div>
          <DataTable
            columns={[t("server.metric"), t("common.value")]}
            rows={(memory?.stats ?? []).map((field) => [field.name, field.value])}
          />
        </div>
      ) : null}

      {view === "monitor" ? (
        <MonitorPanel
          connectionId={connectionId}
          connectionName={connectionName}
          onNotify={onNotify}
          onLog={onLog}
        />
      ) : null}

      {view === "console" ? (
        <ConsoleTab
          connectionId={connectionId}
          connectionName={connectionName}
          initialDb={0}
          onNotify={onNotify}
          onLog={onLog}
        />
      ) : null}
    </div>
  );
}
