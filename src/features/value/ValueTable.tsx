import { memo, useState } from "react";

import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { localizedColumn, useT } from "../../lib/i18n";
import type { ValueCell, ValueRow } from "../../lib/types";
import type { SearchTarget, ValueSearch } from "./search";

interface ValueTableProps {
  columns: string[];
  rows: ValueRow[];
  selectedRow: number | null;
  selectedColumn: number;
  loading: boolean;
  filter: string;
  onFilter: (filter: string) => void;
  /** Rows the local filter operates on (current page / search results). */
  loadedRows: number;
  /** Targets the backend search accepts; empty hides the full-key entry. */
  searchTargets: SearchTarget[];
  search: ValueSearch | null;
  searching: boolean;
  /** False when the backend ignored the search parameters (older build). */
  searchSupported: boolean;
  onSearch: (pattern: string, target: SearchTarget) => void;
  onSearchMore: () => void;
  onClearSearch: () => void;
  onSelect: (row: ValueRow, column: number) => void;
}

function preview(cell: ValueCell | undefined): string {
  if (!cell) return "";
  if (cell.encoding === "base64") {
    return `base64:${cell.payload.slice(0, 40)}${cell.payload.length > 40 ? "…" : ""}`;
  }
  // Truncate before running the newline regex so a large payload is never
  // scanned in full just to build a 200 character preview.
  const clipped = cell.payload.slice(0, 200);
  const oneLine = clipped.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return cell.payload.length > 200 ? `${oneLine}…` : oneLine;
}

/** Full value for the native tooltip, capped so huge values stay cheap. */
function titleOf(cell: ValueCell | undefined): string {
  if (!cell) return "";
  const limit = 400;
  const clipped = cell.payload.slice(0, limit);
  return cell.payload.length > limit ? `${clipped}…` : clipped;
}

/**
 * Rows arrive already paged by the backend, so the table only ever renders one
 * page (bounded by `ValueEditorPageSize`). That keeps the DOM small without a
 * third-party virtualiser. It is memoized so typing in the editor draft below
 * does not re-render every cell.
 */
function ValueTable({
  columns,
  rows,
  selectedRow,
  selectedColumn,
  loading,
  filter,
  onFilter,
  loadedRows,
  searchTargets,
  search,
  searching,
  searchSupported,
  onSearch,
  onSearchMore,
  onClearSearch,
  onSelect,
}: ValueTableProps) {
  const t = useT();
  const [searchDraft, setSearchDraft] = useState("");
  const [target, setTarget] = useState<SearchTarget>(searchTargets[0] ?? "value");
  const effectiveTarget: SearchTarget = searchTargets.includes(target)
    ? target
    : (searchTargets[0] ?? "value");
  const dataColumns = columns.length > 0 && columns[0] === "rowNumber" ? columns.slice(1) : columns;
  const canSearch = searchTargets.length > 0;

  const submitSearch = () => {
    const pattern = searchDraft.trim();
    if (!pattern || searching) return;
    onSearch(pattern, effectiveTarget);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="relative shrink-0">
          <Icon
            name="filter"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
          />
          <input
            className="h-[var(--ui-control)] w-56 rounded-sm border border-border bg-base pl-7 pr-2 t-13 text-text outline-none placeholder:text-muted hover:border-muted/50 focus:border-highlight/60"
            placeholder={t("table.filterRows")}
            value={filter}
            onChange={(event) => onFilter(event.target.value)}
          />
        </div>
        <span className="t-12 text-muted">{t("table.filterLoadedHint", { count: loadedRows })}</span>
        <span className="t-12 text-muted">{t("table.rowsOnPage", { count: rows.length })}</span>
        {canSearch ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
              />
              <input
                className="h-[var(--ui-control)] w-56 rounded-sm border border-border bg-base pl-7 pr-2 t-13 text-text outline-none placeholder:text-muted hover:border-muted/50 focus:border-highlight/60"
                placeholder={t("table.searchAllPlaceholder")}
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitSearch();
                }}
              />
            </div>
            {searchTargets.length > 1 ? (
              <select
                className="h-[var(--ui-control)] rounded-sm border border-border bg-base px-1.5 t-12 text-text outline-none hover:border-muted/50 focus:border-highlight/60"
                value={effectiveTarget}
                onChange={(event) => setTarget(event.target.value as SearchTarget)}
                aria-label={t("table.searchTarget")}
              >
                {searchTargets.map((item) => (
                  <option key={item} value={item}>
                    {item === "field" ? t("table.searchTargetField") : t("table.searchTargetValue")}
                  </option>
                ))}
              </select>
            ) : null}
            <Button variant="secondary" disabled={searching || !searchDraft.trim()} onClick={submitSearch}>
              {searching ? t("common.loading") : t("table.searchAll")}
            </Button>
            {search ? (
              <Button variant="ghost" onClick={onClearSearch}>
                {t("table.searchClear")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {loading || searching ? (
          <span className="flex items-center gap-1.5 t-12 text-muted">
            <span className="spinner inline-block h-3 w-3 rounded-full border border-muted border-t-transparent" />
            {t("common.loading")}
          </span>
        ) : null}
      </div>
      {search ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface/40 px-3 py-1 t-12 text-muted">
          <span>
            {t("table.searchActive", { pattern: search.pattern })}
            {" · "}
            {t("table.searchScanned", { count: search.scanned ?? 0 })}
          </span>
          {search.scanned === null ? (
            <span className="text-danger">{t("table.searchUnsupported")}</span>
          ) : !search.done ? (
            <>
              <span className="text-danger">{t("table.searchIncomplete")}</span>
              <Button variant="secondary" disabled={searching} onClick={onSearchMore}>
                {t("table.searchMore")}
              </Button>
            </>
          ) : null}
        </div>
      ) : !searchSupported ? (
        <div className="border-b border-border bg-surface/40 px-3 py-1 t-12 text-muted">
          {t("table.searchUnsupported")}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse t-content">
          <thead className="sticky top-0 bg-surface text-muted">
            <tr>
              <th className="w-16 border-b border-border px-2 py-1.5 text-right font-normal">
                {t("value.column.number")}
              </th>
              {dataColumns.map((column) => (
                <th
                  key={column}
                  className="border-b border-l border-border px-2 py-1.5 text-left font-normal"
                >
                  {localizedColumn(t, column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isSelected = row.row === selectedRow;
              return (
                <tr
                  key={row.row}
                  className={isSelected ? "bg-highlight/10" : "hover:bg-surface"}
                >
                  <td
                    className={`border-b border-border px-2 py-1.5 text-right font-mono t-12 ${
                      isSelected ? "text-highlight" : "text-muted"
                    }`}
                  >
                    {row.row}
                  </td>
                  {row.columns.map((cell, index) => {
                    const cellSelected = isSelected && index === selectedColumn;
                    return (
                      <td
                        key={index}
                        title={titleOf(cell)}
                        className={`cursor-pointer truncate border-b border-l border-border px-2 py-1.5 font-mono ${
                          cellSelected
                            ? "bg-highlight text-white ring-1 ring-inset ring-highlight"
                            : isSelected
                              ? "text-text hover:bg-highlight/20"
                              : ""
                        }`}
                        onClick={() => onSelect(row, index)}
                      >
                        {preview(cell)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {rows.length === 0 && !loading && !searching ? (
              <tr>
                <td colSpan={dataColumns.length + 1} className="px-2 py-8 text-center text-muted">
                  <div className="flex flex-col items-center gap-1.5">
                    <Icon name="key" className="h-5 w-5 opacity-50" />
                    <span>{search ? t("table.searchNoResults") : t("table.noRows")}</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default memo(ValueTable);
