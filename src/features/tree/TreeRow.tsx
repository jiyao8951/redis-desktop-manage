import { useState } from "react";
import type { FilterHistoryEntry, KeyMeta } from "../../lib/types";
import { databaseLabel, humanTtl } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Icon } from "../../components/ui/Icon";
import Menu, { type MenuItem } from "../../components/ui/Menu";
import FilterBar from "./FilterBar";
import type { TreeRowData } from "./rowTypes";

const TYPE_COLORS: Record<string, string> = {
  string: "#d9534f",
  list: "#f0ad4e",
  set: "#5bc0de",
  zset: "#9b59b6",
  hash: "#5cb85c",
  stream: "#8e44ad",
  vectorset: "#16a085",
};

function Spinner() {
  const t = useT();
  return (
    <span
      className="spinner inline-block h-3 w-3 rounded-full border border-muted border-t-transparent"
      aria-label={t("common.loading")}
    />
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return <Icon name={expanded ? "chevron-down" : "chevron-right"} />;
}

function KeyBadges({ meta }: { meta?: KeyMeta }) {
  const t = useT();
  if (!meta) return null;
  return (
    <>
      {meta.keyType && meta.keyType !== "none" ? (
        <span
          className="rounded-sm px-1 py-[1px] text-[10px] font-semibold text-white"
          style={{ background: TYPE_COLORS[meta.keyType] ?? "#666" }}
          title={`TYPE ${meta.keyType}`}
        >
          {meta.keyType}
        </span>
      ) : null}
      {meta.ttl !== -2 ? (
        <span
          className="rounded-sm border border-border px-1 py-[1px] text-[10px] text-muted"
          title={`TTL ${meta.ttl}`}
        >
          {meta.ttl === -1 ? "∞" : humanTtl(meta.ttl, t("common.noExpiry"))}
        </span>
      ) : null}
    </>
  );
}

export default function TreeRow({
  row,
  selected,
  expanded,
  meta,
  iconColor,
  filterHistory,
  filterBusy,
  menuItems,
  onSelect,
  onToggle,
  onApplyFilter,
  onResetFilter,
  onCloseFilter,
  onLoadMore,
  onConnectionDragStart,
  onDropConnection,
  dragEnabled = false,
}: {
  row: TreeRowData;
  selected: boolean;
  expanded: boolean;
  meta?: KeyMeta;
  iconColor?: string;
  filterHistory: FilterHistoryEntry[];
  filterBusy: boolean;
  menuItems: MenuItem[];
  onSelect: (row: TreeRowData) => void;
  onToggle: (row: TreeRowData) => void;
  onApplyFilter: (dbKey: string, pattern: string) => void;
  onResetFilter: (dbKey: string) => void;
  onCloseFilter: () => void;
  onLoadMore: (row: Extract<TreeRowData, { kind: "loadmore" }>) => void;
  onConnectionDragStart?: (connectionId: string) => void;
  onDropConnection?: (connectionId: string, groupId: string | null) => void;
  /** Server rows are draggable only in Regroup mode, like the original. */
  dragEnabled?: boolean;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const indent = 8 + row.depth * 14;

  if (row.kind === "filter") {
    return (
      <div style={{ paddingLeft: indent }}>
        <FilterBar
          initial={row.db.filter}
          history={filterHistory}
          busy={filterBusy}
          onApply={(pattern) => onApplyFilter(`${row.connection.id}:${row.db.index}`, pattern)}
          onReset={() => onResetFilter(`${row.connection.id}:${row.db.index}`)}
          onClose={onCloseFilter}
        />
      </div>
    );
  }

  if (row.kind === "loadmore") {
    return (
      <div
        className="tree-row flex h-row cursor-pointer items-center gap-2 pr-2 text-[12px] italic text-muted hover:bg-surface"
        style={{ paddingLeft: indent + 14 }}
        onClick={() => onSelect(row)}
      >
        <Icon name="refresh" />
        <button
          type="button"
          className="truncate text-left underline-offset-2 hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onLoadMore(row);
          }}
        >
          {t("tree.loadMore")}
        </button>
      </div>
    );
  }

  if (row.kind === "node") {
    const node = row.node;
    const isNs = node.kind === "namespace";
    return (
      <div
        className={`tree-row group relative flex h-row cursor-pointer items-center gap-1.5 pr-2 text-[12px] ${
          selected ? "bg-highlight text-white" : "hover:bg-surface"
        }`}
        style={{ paddingLeft: indent }}
        onClick={() => onSelect(row)}
        onDoubleClick={() => onToggle(row)}
        title={node.full}
      >
        {isNs ? (
          <button
            type="button"
            className={`shrink-0 rounded-sm p-0.5 ${selected ? "hover:bg-white/15" : "hover:bg-black/10"}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(row);
            }}
            aria-label={node.id}
          >
            {node.loading ? <Spinner /> : <Chevron expanded={expanded} />}
          </button>
        ) : (
          <span className="w-[18px] shrink-0" />
        )}

        <span className={isNs ? "text-[#e8b339]" : "text-muted"}>
          <Icon name={isNs ? "folder" : "key"} />
        </span>
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {isNs ? (
          <span className={`text-[11px] ${selected ? "text-white/80" : "text-muted"}`}>
            ({node.keyCount})
          </span>
        ) : null}
        <KeyBadges meta={meta} />

        {menuItems.length ? (
          <button
            type="button"
            className={`rounded-sm p-1 transition-colors ${
              selected
                ? "text-white/80 hover:bg-white/15 hover:text-white"
                : "text-muted opacity-0 hover:bg-black/10 hover:text-text group-hover:opacity-100"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label={t("tree.actions")}
          >
            <Icon name="more" />
          </button>
        ) : null}
        {menuOpen ? (
          <Menu className="right-1 top-[26px]" items={menuItems} onClose={() => setMenuOpen(false)} />
        ) : null}
      </div>
    );
  }

  if (row.kind === "database") {
    const db = row.db;
    return (
      <div
        className={`tree-row group relative flex h-row cursor-pointer items-center gap-1.5 pr-2 text-[12px] ${
          selected ? "bg-highlight text-white" : "hover:bg-surface"
        }`}
        style={{ paddingLeft: indent }}
        onClick={() => onSelect(row)}
        onDoubleClick={() => onToggle(row)}
      >
        <button
          type="button"
          className={`shrink-0 rounded-sm p-0.5 ${selected ? "hover:bg-white/15" : "hover:bg-black/10"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row);
          }}
          aria-label={`db${db.index}`}
        >
          {db.loading ? <Spinner /> : <Chevron expanded={expanded} />}
        </button>
        <span className="text-muted">
          <Icon name="database" />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {databaseLabel(db.index, db.keys, db.loaded ? db.filter : null, t("tree.filterSuffix"))}
        </span>
        {db.loading ? <Spinner /> : null}
        {menuItems.length ? (
          <button
            type="button"
            className={`rounded-sm p-1 transition-colors ${
              selected
                ? "text-white/80 hover:bg-white/15 hover:text-white"
                : "text-muted opacity-0 hover:bg-black/10 hover:text-text group-hover:opacity-100"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label={t("tree.actions")}
          >
            <Icon name="more" />
          </button>
        ) : null}
        {menuOpen ? (
          <Menu className="right-1 top-[26px]" items={menuItems} onClose={() => setMenuOpen(false)} />
        ) : null}
      </div>
    );
  }

  if (row.kind === "server") {
    const view = row.view;
    return (
      <div
        className={`tree-row group relative flex h-row cursor-pointer items-center gap-1.5 pr-2 text-[12px] font-semibold ${
          selected ? "bg-highlight text-white" : "hover:bg-surface"
        }`}
        style={{ paddingLeft: indent }}
        onClick={() => onSelect(row)}
        onDoubleClick={() => onToggle(row)}
        draggable={dragEnabled}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-resp-connection", row.connection.id);
          event.dataTransfer.effectAllowed = "move";
          onConnectionDragStart?.(row.connection.id);
        }}
      >
        <button
          type="button"
          className={`shrink-0 rounded-sm p-0.5 ${selected ? "hover:bg-white/15" : "hover:bg-black/10"}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row);
          }}
          aria-label={row.connection.name}
        >
          {view.loading ? <Spinner /> : <Chevron expanded={expanded} />}
        </button>
        <span className="text-muted" style={iconColor ? { color: iconColor } : undefined}>
          <Icon name="database" />
        </span>
        <span className="min-w-0 flex-1 truncate">{row.connection.name}</span>
        <span
          className={`shrink-0 truncate text-[10.5px] font-normal ${
            selected ? "text-white/75" : "text-muted"
          }`}
          style={{ maxWidth: "45%" }}
        >
          {row.connection.host}:{row.connection.port}
        </span>
        {view.error ? (
          <span className="text-[10px] font-normal text-danger">{t("tree.errorBadge")}</span>
        ) : null}
        {menuItems.length ? (
          <button
            type="button"
            className={`rounded-sm p-1 transition-colors ${
              selected
                ? "text-white/80 hover:bg-white/15 hover:text-white"
                : "text-muted opacity-0 hover:bg-black/10 hover:text-text group-hover:opacity-100"
            }`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            aria-label={t("tree.actions")}
          >
            <Icon name="more" />
          </button>
        ) : null}
        {menuOpen ? (
          <Menu className="right-1 top-[26px]" items={menuItems} onClose={() => setMenuOpen(false)} />
        ) : null}
      </div>
    );
  }

  // group
  return (
    <div
      className={`tree-row group relative flex h-row cursor-pointer items-center gap-1.5 pr-2 text-[12px] ${
        dropActive
          ? "bg-highlight/40 ring-1 ring-inset ring-accent"
          : selected
            ? "bg-highlight text-white"
            : "hover:bg-surface"
      }`}
      style={{ paddingLeft: indent }}
      onClick={() => onSelect(row)}
      onDoubleClick={() => onToggle(row)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("application/x-resp-connection")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        const connectionId = event.dataTransfer.getData("application/x-resp-connection");
        if (connectionId) onDropConnection?.(connectionId, row.group.id);
      }}
    >
      <button
        type="button"
        className="shrink-0 rounded-sm p-0.5 hover:bg-black/10"
        onClick={(e) => {
          e.stopPropagation();
          onToggle(row);
        }}
        aria-label={row.group.name}
      >
        <Chevron expanded={expanded} />
      </button>
      <span className="text-muted">
        <Icon name="group" />
      </span>
      <span className="min-w-0 flex-1 truncate">{row.group.name}</span>
      {menuItems.length ? (
        <button
          type="button"
          className={`rounded-sm px-1 text-muted hover:bg-black/10 hover:text-text ${
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label={t("tree.actions")}
        >
          ⋯
        </button>
      ) : null}
      {menuOpen ? (
        <Menu className="right-1 top-6" items={menuItems} onClose={() => setMenuOpen(false)} />
      ) : null}
    </div>
  );
}
