import { localizedColumn, useT } from "../../lib/i18n";
import type { ValueCell, ValueRow } from "../../lib/types";

interface ValueTableProps {
  columns: string[];
  rows: ValueRow[];
  selectedRow: number | null;
  selectedColumn: number;
  loading: boolean;
  filter: string;
  onFilter: (filter: string) => void;
  onSelect: (row: ValueRow, column: number) => void;
}

function preview(cell: ValueCell | undefined): string {
  if (!cell) return "";
  if (cell.encoding === "base64") {
    return `base64:${cell.payload.slice(0, 40)}${cell.payload.length > 40 ? "…" : ""}`;
  }
  const oneLine = cell.payload.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

/**
 * Rows arrive already paged by the backend, so the table only ever renders one
 * page (bounded by `ValueEditorPageSize`). That keeps the DOM small without a
 * third-party virtualiser.
 */
export default function ValueTable({
  columns,
  rows,
  selectedRow,
  selectedColumn,
  loading,
  filter,
  onFilter,
  onSelect,
}: ValueTableProps) {
  const t = useT();
  const dataColumns = columns.length > 0 && columns[0] === "rowNumber" ? columns.slice(1) : columns;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
        <input
          className="h-7 w-64 rounded border border-border bg-base px-2 text-xs text-text outline-none placeholder:text-muted"
          placeholder={t("table.filterRows")}
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
        />
        <span className="text-xs text-muted">{t("table.rowsOnPage", { count: rows.length })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-surface text-muted">
            <tr>
              <th className="w-16 border-b border-border px-2 py-1 text-right font-normal">
                {t("value.column.number")}
              </th>
              {dataColumns.map((column) => (
                <th
                  key={column}
                  className="border-b border-l border-border px-2 py-1 text-left font-normal"
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
                <tr key={row.row} className={isSelected ? "bg-highlight" : "hover:bg-surface"}>
                  <td className="border-b border-border px-2 py-0.5 text-right text-muted">
                    {row.row}
                  </td>
                  {row.columns.map((cell, index) => (
                    <td
                      key={index}
                      className={`cursor-pointer border-b border-l border-border px-2 py-0.5 font-mono${
                        isSelected && index === selectedColumn
                          ? " ring-1 ring-inset ring-accent"
                          : ""
                      }`}
                      onClick={() => onSelect(row, index)}
                    >
                      {preview(cell)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length === 0 && !loading ? (
              <tr>
                <td colSpan={dataColumns.length + 1} className="px-2 py-6 text-center text-muted">
                  {t("table.noRows")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {loading ? <div className="px-3 py-2 text-xs text-muted">{t("common.loading")}</div> : null}
      </div>
    </div>
  );
}
