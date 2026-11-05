import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Dialog from "../../components/ui/Dialog";
import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { TextInput } from "../../components/ui/fields";
import { ipc } from "../../lib/ipc";
import { errMessage, humanBytes, humanTtl } from "../../lib/format";
import { localizedColumn, useT, type TFunction } from "../../lib/i18n";
import type {
  KeyValueChunk,
  KeyValueInfo,
  Settings,
  ValueCell,
  ValuePage,
  ValueRow,
} from "../../lib/types";
import { isBinary, textOf } from "./formatters";
import type { FormatterId } from "./formatters";
import Pagination from "./Pagination";
import ValueEditorPane from "./ValueEditorPane";
import ValueTable from "./ValueTable";

const CHUNK_BYTES = 64 * 1024;
const INDEXED_COLUMNS = ["rowNumber", "value"];

interface ValueTabProps {
  connectionId: string;
  connectionName: string;
  db: number;
  keyName: string;
  settings: Settings;
  onNotify: (message: string) => void;
  onLog: (message: string, level?: "info" | "error") => void;
  onRename?: (newName: string) => void;
  /** Reports unsaved editor drafts so closing the tab can ask first. */
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
}

function cursorPaged(keyType: string): boolean {
  return keyType === "hash" || keyType === "set" || keyType === "stream";
}

function chunkBytes(chunk: KeyValueChunk): Uint8Array {
  if (chunk.encoding === "base64") {
    const binary = atob(chunk.payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(chunk.payload);
}

function cellFromBytes(bytes: Uint8Array): ValueCell {
  if (!isBinary(bytes)) {
    return { encoding: "utf8", payload: textOf(bytes) };
  }
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return { encoding: "base64", payload: btoa(binary) };
}

function columnLabel(t: TFunction, columns: string[], index: number): string {
  const dataColumns = columns.length > 0 && columns[0] === "rowNumber" ? columns.slice(1) : columns;
  return localizedColumn(t, dataColumns[index] ?? "value");
}

const FORMATTER_IDS: FormatterId[] = ["auto", "text", "json", "hex", "hex-table", "base64-text"];

function formatterFromConfig(value: string | undefined): FormatterId {
  return FORMATTER_IDS.includes(value as FormatterId) ? (value as FormatterId) : "auto";
}

/** Add-row form matching the columns of each collection editor. */
function RowDialog({
  keyType,
  busy,
  onCancel,
  onSubmit,
}: {
  keyType: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (cells: ValueCell[]) => void;
}) {
  const t = useT();
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState(keyType === "zset" ? "0" : "");

  const title =
    keyType === "hash"
      ? t("value.newHashField")
      : keyType === "set"
        ? t("value.newSetMember")
        : keyType === "zset"
          ? t("value.newZsetMember")
          : t("value.newListElement");

  const submit = () => {
    const text = (value: string): ValueCell => ({ encoding: "utf8", payload: value });
    if (keyType === "hash") onSubmit([text(first), text(second)]);
    else if (keyType === "zset") onSubmit([text(first), text(second || "0")]);
    else onSubmit([text(first)]);
  };

  return (
    <Dialog
      title={title}
      width={440}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? t("common.saving") : t("common.add")}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {keyType === "hash" || keyType === "zset" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">
              {keyType === "hash" ? t("value.fieldLabel") : t("value.memberLabel")}
            </span>
            <TextInput value={first} onChange={(e) => setFirst(e.target.value)} />
          </label>
        ) : null}
        {keyType === "zset" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("value.scoreLabel")}</span>
            <TextInput value={second} onChange={(e) => setSecond(e.target.value)} />
          </label>
        ) : null}
        {keyType === "hash" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("value.valueLabel")}</span>
            <textarea
              className="h-28 w-full resize-none rounded-sm border border-border bg-base px-2 py-1 font-mono t-13 outline-none"
              value={second}
              onChange={(event) => setSecond(event.target.value)}
            />
          </label>
        ) : null}
        {keyType === "list" || keyType === "set" ? (
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("value.valueLabel")}</span>
            <textarea
              className="h-28 w-full resize-none rounded-sm border border-border bg-base px-2 py-1 font-mono t-13 outline-none"
              value={first}
              onChange={(event) => setFirst(event.target.value)}
            />
          </label>
        ) : null}
      </div>
    </Dialog>
  );
}

export default function ValueTab({
  connectionId,
  connectionName,
  db,
  keyName,
  settings,
  onNotify,
  onLog,
  onRename,
  onDirtyChange,
  onClose,
}: ValueTabProps) {
  const t = useT();
  const dirtyRef = useRef({ string: false, cell: false });
  const reportDirty = useCallback(
    (slot: "string" | "cell", value: boolean) => {
      if (dirtyRef.current[slot] === value) return;
      dirtyRef.current[slot] = value;
      onDirtyChange?.(dirtyRef.current.string || dirtyRef.current.cell);
    },
    [onDirtyChange],
  );
  const reportStringDirty = useCallback(
    (value: boolean) => reportDirty("string", value),
    [reportDirty],
  );
  const reportCellDirty = useCallback(
    (value: boolean) => reportDirty("cell", value),
    [reportDirty],
  );
  const pageSize = Math.max(10, settings.valueEditorPageSize);
  const sizeLimit = Math.max(1, settings.valueSizeLimit);

  const seq = useRef(0);
  const lastKeyRef = useRef(keyName);
  const accRef = useRef<ValueRow[]>([]);
  const cursorRef = useRef("0");
  const doneRef = useRef(false);
  const rowsLoadingRef = useRef(false);

  const [info, setInfo] = useState<KeyValueInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);

  const [page, setPage] = useState(0);
  const [indexedPage, setIndexedPage] = useState<ValuePage | null>(null);
  const [acc, setAcc] = useState<ValueRow[]>([]);
  const [cursor, setCursor] = useState("0");
  const [done, setDone] = useState(false);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [filter, setFilter] = useState("");

  const [bytes, setBytes] = useState<Uint8Array>(new Uint8Array());
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [chunkLoading, setChunkLoading] = useState(false);
  /** Bumped whenever the data behind the editor is reloaded, resetting drafts. */
  const [dataVersion, setDataVersion] = useState(0);

  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const [formatter, setFormatter] = useState<FormatterId>("auto");
  const [saving, setSaving] = useState(false);
  const [addRowOpen, setAddRowOpen] = useState(false);
  const [ttlOpen, setTtlOpen] = useState(false);
  const [ttlValue, setTtlValue] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    // Per-connection default formatter (original ConnectionConfig). The
    // "last_used" mode is not persisted by this build, so it maps to auto.
    let cancelled = false;
    ipc
      .getConnection(connectionId)
      .then((config) => {
        if (!cancelled) setFormatter(formatterFromConfig(config.defaultFormatter));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const setCursorState = (rows: ValueRow[], nextCursor: string, exhausted: boolean) => {
    accRef.current = rows;
    cursorRef.current = nextCursor;
    doneRef.current = exhausted;
    setAcc(rows);
    setCursor(nextCursor);
    setDone(exhausted);
    setDataVersion((version) => version + 1);
  };

  const loadChunks = useCallback(
    async (reset: boolean, target: number) => {
      const ticket = seq.current;
      setChunkLoading(true);
      try {
        // Keep the already loaded chunks as one part and concatenate once at
        // the end instead of reallocating the whole value per chunk.
        const parts: Uint8Array[] = reset ? [] : [bytes];
        let offset = reset ? 0 : loadedBytes;
        let total: number | null = reset ? null : totalBytes;
        let reachedLimit = false;

        while (offset < target) {
          const chunk = await ipc.readStringChunk({
            connectionId,
            db,
            key: keyName,
            offset,
            limit: CHUNK_BYTES,
            knownTotal: total ?? undefined,
          });
          if (seq.current !== ticket) return;
          const part = chunkBytes(chunk);
          total = chunk.totalBytes ?? total;
          if (part.length === 0) break;
          parts.push(part);
          offset += part.length;
          if (!chunk.truncated) break;
        }

        let merged: Uint8Array;
        if (parts.length === 1) {
          merged = parts[0];
        } else {
          const length = parts.reduce((sum, part) => sum + part.length, 0);
          merged = new Uint8Array(length);
          let at = 0;
          for (const part of parts) {
            merged.set(part, at);
            at += part.length;
          }
        }

        setBytes(merged);
        setLoadedBytes(merged.length);
        setTotalBytes(total);
        setDataVersion((version) => version + 1);
        if (Number.isFinite(target) && total !== null && merged.length < total) {
          reachedLimit = true;
        }
        if (reachedLimit) {
          onNotify(
            t("value.limitNotify", {
              size: humanBytes(merged.length),
              limit: humanBytes(sizeLimit),
            }),
          );
        }
      } catch (e) {
        if (seq.current !== ticket) return;
        const message = errMessage(e);
        setError(message);
        onLog(t("value.cannotRead", { key: keyName, error: message }), "error");
      } finally {
        if (seq.current === ticket) setChunkLoading(false);
      }
    },
    [
      bytes,
      connectionId,
      db,
      keyName,
      loadedBytes,
      onLog,
      onNotify,
      sizeLimit,
      t,
      totalBytes,
    ],
  );

  const loadIndexed = useCallback(
    async (meta: KeyValueInfo, target: number, reversed: boolean) => {
      const ticket = seq.current;
      rowsLoadingRef.current = true;
      setRowsLoading(true);
      try {
        const result = await ipc.readValuePage({
          connectionId,
          db,
          key: keyName,
          keyType: meta.keyType,
          cursor: "0",
          start: target * pageSize,
          count: pageSize,
          reverse: reversed,
        });
        if (seq.current !== ticket) return;
        setIndexedPage(result);
        setSelected(null);
        setDataVersion((version) => version + 1);
      } catch (e) {
        if (seq.current !== ticket) return;
        const message = errMessage(e);
        setError(message);
        onLog(t("value.cannotPage", { key: keyName, error: message }), "error");
      } finally {
        // Reset unconditionally: a reload/rename invalidates the ticket while
        // this request is in flight, and gating the reset caused a permanent
        // spinner and a disabled "Next".
        rowsLoadingRef.current = false;
        setRowsLoading(false);
      }
    },
    [connectionId, db, keyName, onLog, pageSize, t],
  );

  const fetchCursorMore = useCallback(
    async (meta: KeyValueInfo) => {
      if (doneRef.current || rowsLoadingRef.current) return;
      const ticket = seq.current;
      rowsLoadingRef.current = true;
      setRowsLoading(true);
      try {
        const result = await ipc.readValuePage({
          connectionId,
          db,
          key: keyName,
          keyType: meta.keyType,
          cursor: cursorRef.current,
          start: accRef.current.length,
          count: pageSize,
          reverse: false,
        });
        if (seq.current !== ticket) return;
        setCursorState(
          [...accRef.current, ...result.rows],
          result.cursor,
          result.done || result.rows.length === 0,
        );
      } catch (e) {
        if (seq.current !== ticket) return;
        const message = errMessage(e);
        setError(message);
        onLog(t("value.cannotPage", { key: keyName, error: message }), "error");
      } finally {
        rowsLoadingRef.current = false;
        setRowsLoading(false);
      }
    },
    [connectionId, db, keyName, onLog, pageSize, t],
  );

  const reload = useCallback(async () => {
    const ticket = (seq.current += 1);
    // A previous request may still hold the loading flag; reload must not skip
    // its own fetch because of a stale ticket.
    rowsLoadingRef.current = false;
    setRowsLoading(false);
    setLoadingInfo(true);
    setError(null);
    // Keep the previous header info while reloading the same key so the top
    // bar does not flash empty; drop it only when switching to another key.
    if (lastKeyRef.current !== keyName) {
      lastKeyRef.current = keyName;
      setInfo(null);
    }
    setFilter("");
    setSelected(null);
    setPage(0);
    setIndexedPage(null);
    setCursorState([], "0", false);
    setBytes(new Uint8Array());
    setLoadedBytes(0);
    setTotalBytes(null);

    try {
      const meta = await ipc.keyValueInfo({ connectionId, db, key: keyName });
      if (seq.current !== ticket) return;
      setInfo(meta);
      if (!meta.supported) return;
      if (meta.singleRow) {
        await loadChunks(true, sizeLimit);
      } else if (cursorPaged(meta.keyType)) {
        await fetchCursorMore(meta);
      } else {
        await loadIndexed(meta, 0, reverse);
      }
    } catch (e) {
      if (seq.current !== ticket) return;
      const message = errMessage(e);
      setError(message);
      onLog(t("value.cannotOpen", { key: keyName, error: message }), "error");
    } finally {
      if (seq.current === ticket) setLoadingInfo(false);
    }
  }, [connectionId, db, keyName, onLog, loadChunks, fetchCursorMore, loadIndexed, reverse, sizeLimit, t]);

  useEffect(() => {
    void reload();
    return () => {
      // Invalidate in-flight requests when the tab closes.
      seq.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, db, keyName]);

  const meta = info;
  const isCursorMode = meta ? cursorPaged(meta.keyType) : false;

  // Scan cursors can embed echoed payloads; show only the scan position.
  const cursorLabel = useMemo(() => {
    try {
      const parsed = JSON.parse(cursor) as { scan?: unknown };
      if (parsed && (typeof parsed.scan === "string" || typeof parsed.scan === "number")) {
        return String(parsed.scan);
      }
    } catch {
      // Cursor is not structured JSON; fall back to a clipped string.
    }
    return cursor === "0" ? cursor : cursor.length > 24 ? `${cursor.slice(0, 24)}…` : cursor;
  }, [cursor]);

  // String view: decode/format once per byte snapshot, not on every keystroke.
  const stringCell = useMemo(() => cellFromBytes(bytes), [bytes]);
  const stringBinary = useMemo(() => isBinary(bytes), [bytes]);
  const stringText = useMemo(() => textOf(bytes), [bytes]);
  const fullyLoaded = Boolean(
    meta?.singleRow && totalBytes !== null && loadedBytes >= totalBytes,
  );
  const partialLoad = Boolean(
    meta?.singleRow && totalBytes !== null && loadedBytes < totalBytes,
  );

  const pageRows = useMemo(
    () =>
      isCursorMode
        ? acc.slice(page * pageSize, (page + 1) * pageSize)
        : (indexedPage?.rows ?? []),
    [isCursorMode, acc, page, pageSize, indexedPage],
  );

  const rows = useMemo(() => {
    if (!filter) return pageRows;
    const needle = filter.toLowerCase();
    return pageRows.filter((row) =>
      row.columns.some((cell) => cell.payload.toLowerCase().includes(needle)),
    );
  }, [pageRows, filter]);

  const columns = useMemo(
    () =>
      isCursorMode
        ? meta?.keyType === "hash"
          ? ["rowNumber", "key", "value"]
          : meta?.keyType === "stream"
            ? ["rowNumber", "id", "value"]
            : ["rowNumber", "value"]
        : (indexedPage?.columns ?? INDEXED_COLUMNS),
    [isCursorMode, indexedPage, meta?.keyType],
  );

  const total = meta?.length ?? (isCursorMode ? acc.length : (indexedPage?.total ?? null));
  const pageCount = isCursorMode
    ? total !== null && total >= 0
      ? Math.max(1, Math.ceil(total / pageSize))
      : null
    : total !== null
      ? Math.max(1, Math.ceil(total / pageSize))
      : null;
  const loadedCount = isCursorMode ? acc.length : (indexedPage?.rows.length ?? 0);

  const nextDisabled = isCursorMode
    ? (done && (page + 2) * pageSize > acc.length) || rowsLoading
    : pageCount !== null
      ? page + 1 >= pageCount || rowsLoading
      : true;

  const goNext = async () => {
    if (!meta) return;
    if (isCursorMode) {
      const needed = (page + 2) * pageSize;
      const before = acc.length;
      if (before < needed && !done) {
        await fetchCursorMore(meta);
      }
      if (accRef.current.length >= needed || (!doneRef.current && accRef.current.length > before)) {
        setPage(page + 1);
      }
      return;
    }
    if (pageCount !== null && page + 1 < pageCount) {
      const target = page + 1;
      setPage(target);
      await loadIndexed(meta, target, reverse);
    }
  };

  const goPrev = async () => {
    if (!meta || page === 0) return;
    if (isCursorMode) {
      setPage(page - 1);
      return;
    }
    const target = page - 1;
    setPage(target);
    await loadIndexed(meta, target, reverse);
  };

  const goTo = async (target: number) => {
    if (!meta) return;
    if (isCursorMode) {
      let guard = 0;
      while (!doneRef.current && accRef.current.length < (target + 1) * pageSize && guard < 50) {
        const before = accRef.current.length;
        await fetchCursorMore(meta);
        guard += 1;
        if (accRef.current.length === before) break;
      }
      const lastPage = Math.max(0, Math.floor((accRef.current.length - 1) / pageSize));
      setPage(Math.min(target, lastPage));
      return;
    }
    if (pageCount !== null) {
      const next = Math.min(target, pageCount - 1);
      setPage(next);
      await loadIndexed(meta, next, reverse);
    }
  };

  const changeReverse = async (value: boolean) => {
    setReverse(value);
    if (!meta || isCursorMode) return;
    setPage(0);
    await loadIndexed(meta, 0, value);
  };

  const deleteKey = async () => {
    if (!meta) return;
    if (!window.confirm(t("tree.deleteKeyConfirm"))) return;
    try {
      await ipc.deleteKey({ connectionId, db, key: keyName });
      onNotify(t("value.deletedKey", { key: keyName }));
      onClose();
    } catch (e) {
      onNotify(errMessage(e));
    }
  };

  const saveString = async (value: string) => {
    if (!meta || saving) return;
    if (!fullyLoaded) {
      onNotify(t("value.truncatedWarning"));
      return;
    }
    if (stringBinary) return;
    setSaving(true);
    try {
      await ipc.saveStringValue({
        connectionId,
        db,
        key: keyName,
        value: { encoding: "utf8", payload: value },
      });
      onNotify(t("value.valueSaved"));
      await loadChunks(true, sizeLimit);
    } catch (e) {
      onNotify(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const selectedRowData = pageRows.find((row) => row.row === selected?.row) ?? null;
  const selectedCell = selectedRowData?.columns[selected?.column ?? 0] ?? null;
  const selectedLabel = selected
    ? t("value.rowLabel", {
        row: selected.row,
        column: columnLabel(t, columns, selected.column),
      })
    : t("common.value");

  const canEditCell = Boolean(
    meta && meta.keyType !== "stream" && selectedCell && selectedCell.encoding === "utf8",
  );

  const listPosition = (row: number) => (reverse ? -(row + 1) : row);

  const saveCell = async (text: string) => {
    if (!meta || !selected || !selectedRowData || !canEditCell || saving) return;
    const newColumns: ValueCell[] = selectedRowData.columns.map((cell, index) =>
      index === selected.column ? { encoding: "utf8" as const, payload: text } : cell,
    );
    setSaving(true);
    try {
      await ipc.updateValueRow({
        connectionId,
        db,
        key: keyName,
        keyType: meta.keyType,
        request: {
          old: selectedRowData.columns,
          new: newColumns,
          position: meta.keyType === "list" ? listPosition(selectedRowData.row) : null,
        },
      });
      onNotify(t("value.rowSaved"));
      await reload();
    } catch (e) {
      onNotify(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async () => {
    if (!meta || !selectedRowData || saving) return;
    const last = meta.length === 1;
    const message = last ? t("value.deleteLastRowConfirm") : t("value.deleteRowConfirm");
    if (!window.confirm(message)) return;
    setSaving(true);
    try {
      await ipc.deleteValueRow({
        connectionId,
        db,
        key: keyName,
        keyType: meta.keyType,
        old: selectedRowData.columns,
        position: meta.keyType === "list" ? listPosition(selectedRowData.row) : null,
      });
      onNotify(t("value.rowRemoved"));
      if (last) onClose();
      else await reload();
    } catch (e) {
      onNotify(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const addRow = async (cells: ValueCell[]) => {
    if (!meta) return;
    setSaving(true);
    try {
      await ipc.addValueRow({
        connectionId,
        db,
        key: keyName,
        keyType: meta.keyType,
        cells,
      });
      onNotify(t("value.rowAdded"));
      setAddRowOpen(false);
      await reload();
    } catch (e) {
      onNotify(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const applyTtl = async (persist: boolean) => {
    if (!meta) return;
    setSaving(true);
    try {
      if (persist) {
        await ipc.persistKey({ connectionId, db, key: keyName });
        onNotify(t("value.ttlRemoved"));
      } else {
        const ttl = Number.parseInt(ttlValue, 10);
        if (!Number.isFinite(ttl)) {
          onNotify(t("value.ttlMustBeNumber"));
          return;
        }
        if (ttl < 0) {
          onNotify(t("value.ttlMustBeNonNegative"));
          return;
        }
        if (ttl === 0) {
          // EXPIRE 0 deletes the key, so zero means PERSIST here.
          await ipc.persistKey({ connectionId, db, key: keyName });
          onNotify(t("value.ttlRemoved"));
        } else {
          await ipc.setKeyTtl({ connectionId, db, key: keyName, ttl });
          onNotify(t("value.ttlSet", { ttl }));
        }
      }
      setTtlOpen(false);
      await reload();
    } catch (e) {
      onNotify(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const applyRename = async () => {
    if (!meta) return;
    const target = renameValue.trim();
    if (!target) {
      onNotify(t("value.keyNameRequired"));
      return;
    }
    setSaving(true);
    try {
      await ipc.renameKey({
        connectionId,
        db,
        key: keyName,
        newKey: target,
        ttl: meta.ttl > 0 ? meta.ttl : 0,
      });
      setRenameOpen(false);
      onNotify(t("value.keyRenamed", { name: target }));
      if (onRename) onRename(target);
      else await reload();
    } catch (e) {
      onNotify(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => onNotify(t("common.copied")),
      () => onNotify(t("common.clipboardUnavailable")),
    );
  };

  const handleSelect = useCallback((row: ValueRow, column: number) => {
    setSelected({ row: row.row, column });
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-col bg-base">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="shrink-0 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono t-11 font-semibold uppercase text-accent">
          {meta?.keyType ?? "…"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono t-title font-medium text-text" title={keyName}>
            {keyName}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 t-12 text-muted">
            <span>
              {connectionName} · db{db}
            </span>
            {meta ? (
              <span className="rounded-sm border border-border px-1.5 py-[1px] font-mono t-11">
                TTL {humanTtl(meta.ttl, t("common.noExpiry"), t("common.missing"))}
              </span>
            ) : null}
            {meta?.length !== null && meta ? (
              <span className="rounded-sm border border-border px-1.5 py-[1px] font-mono t-11">
                {t("value.items", { count: meta.length })}
              </span>
            ) : null}
            {meta?.encoding ? (
              <span className="rounded-sm border border-border px-1.5 py-[1px] font-mono t-11">
                {meta.encoding}
              </span>
            ) : null}
            {meta?.memoryBytes !== null && meta ? (
              <span className="rounded-sm border border-border px-1.5 py-[1px] font-mono t-11">
                {humanBytes(meta.memoryBytes)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            onClick={() => {
              setTtlValue(meta && meta.ttl > 0 ? String(meta.ttl) : "");
              setTtlOpen(true);
            }}
            disabled={!meta}
          >
            TTL
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setRenameValue(keyName);
              setRenameOpen(true);
            }}
            disabled={!meta}
          >
            <Icon name="edit" className="h-3.5 w-3.5" />
            {t("common.rename")}
          </Button>
          <Button variant="ghost" onClick={() => void reload()} disabled={loadingInfo}>
            <Icon name="refresh" className="h-3.5 w-3.5" />
            {t("common.reload")}
          </Button>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden="true" />
          <Button variant="danger" onClick={() => void deleteKey()} disabled={!meta}>
            <Icon name="trash" className="h-3.5 w-3.5" />
            {t("common.delete")}
          </Button>
        </div>
      </header>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 t-14 text-danger">
          <div>{error}</div>
          <button
            type="button"
            className="rounded border border-border px-3 py-1 t-13 text-text"
            onClick={() => void reload()}
          >
            {t("common.retry")}
          </button>
        </div>
      ) : loadingInfo && !meta ? (
        <div className="flex flex-1 items-center justify-center t-14 text-muted">
          {t("common.loading")}
        </div>
      ) : !meta ? null : !meta.supported ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 t-14">
          <div className="font-mono uppercase text-muted">{meta.keyType}</div>
          <div className="text-text">{t("value.unsupported")}</div>
          <div className="t-content text-muted">
            TTL {humanTtl(meta.ttl, t("common.noExpiry"), t("common.missing"))}
            {meta.memoryBytes !== null ? ` · ${humanBytes(meta.memoryBytes)}` : ""}
          </div>
        </div>
      ) : meta.singleRow ? (
        <>
          <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 t-content text-muted">
            <span>
              {t("value.bytes", {
                loaded: loadedBytes.toLocaleString(),
                total: (totalBytes ?? meta.length ?? 0).toLocaleString(),
              })}
              {partialLoad ? ` · ${t("value.displayLimit", { limit: humanBytes(sizeLimit) })}` : ""}
            </span>
            {partialLoad ? (
              <span className="text-danger">{t("value.truncatedWarning")}</span>
            ) : null}
            {partialLoad ? (
              <button
                type="button"
                className="rounded border border-border px-2 py-0.5 text-text"
                onClick={() => void loadChunks(false, Number.POSITIVE_INFINITY)}
                disabled={chunkLoading}
              >
                {t("value.loadMore")}
              </button>
            ) : null}
            {chunkLoading ? <span>{t("common.loading")}</span> : null}
          </div>
          <ValueEditorPane
            fill
            label={t("common.value")}
            cell={stringCell}
            formatter={formatter}
            limit={sizeLimit}
            editing={fullyLoaded && !stringBinary}
            sourceText={stringText}
            editKey={`string:${dataVersion}`}
            saving={saving}
            fontFamily={settings.valueEditorFont}
            fontSize={settings.valueEditorFontSize}
            onDirtyChange={reportStringDirty}
            onFormatter={setFormatter}
            onSave={(text) => void saveString(text)}
            onCopy={copy}
          />
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 t-content text-muted">
            {(meta.keyType === "list" || meta.keyType === "zset") && (
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={reverse}
                  onChange={(event) => void changeReverse(event.target.checked)}
                />
                {t("value.reverseOrder")}
              </label>
            )}
            {meta.keyType !== "stream" ? (
              <>
                <Button variant="secondary" onClick={() => setAddRowOpen(true)} disabled={saving}>
                  <Icon name="plus" className="h-3.5 w-3.5" />
                  {meta.keyType === "hash" ? t("value.addField") : t("value.addRow")}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void deleteRow()}
                  disabled={!selectedRowData || saving}
                >
                  <Icon name="trash" className="h-3.5 w-3.5" />
                  {t("value.deleteRow")}
                </Button>
              </>
            ) : (
              <span>{t("value.newestFirst")}</span>
            )}
            {isCursorMode ? (
              <span
                className="ml-auto shrink-0 truncate t-12 text-muted"
                title={t("value.cursorStatus", {
                  cursor,
                  state: done ? t("value.exhausted") : t("value.moreAvailable"),
                })}
              >
                {t("value.cursorStatus", {
                  cursor: cursorLabel,
                  state: done ? t("value.exhausted") : t("value.moreAvailable"),
                })}
              </span>
            ) : null}
          </div>
          <ValueTable
            columns={columns}
            rows={rows}
            selectedRow={selected?.row ?? null}
            selectedColumn={selected?.column ?? 0}
            loading={rowsLoading}
            filter={filter}
            onFilter={setFilter}
            onSelect={handleSelect}
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            loaded={loadedCount}
            total={total}
            pageSize={pageSize}
            prevDisabled={page === 0 || rowsLoading}
            nextDisabled={nextDisabled}
            onPrev={() => void goPrev()}
            onNext={() => void goNext()}
            onGoTo={(target) => void goTo(target)}
          />
          <ValueEditorPane
            label={selectedLabel}
            cell={selectedCell}
            formatter={formatter}
            limit={sizeLimit}
            editing={canEditCell}
            sourceText={selectedCell?.payload ?? ""}
            editKey={
              selected
                ? `${selected.row}:${selected.column}:${dataVersion}`
                : `none:${dataVersion}`
            }
            saving={saving}
            fontFamily={settings.valueEditorFont}
            fontSize={settings.valueEditorFontSize}
            onDirtyChange={reportCellDirty}
            onFormatter={setFormatter}
            onSave={(text) => void saveCell(text)}
            onCopy={copy}
          />
        </>
      )}

      {ttlOpen ? (
        <Dialog
          title={t("value.ttlDialogTitle")}
          width={360}
          onClose={() => setTtlOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setTtlOpen(false)} disabled={saving}>
                {t("common.cancel")}
              </Button>
              <Button variant="secondary" onClick={() => void applyTtl(true)} disabled={saving}>
                {t("value.persistKey")}
              </Button>
              <Button variant="primary" onClick={() => void applyTtl(false)} disabled={saving}>
                {t("common.save")}
              </Button>
            </>
          }
        >
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("value.newTtl")}</span>
            <TextInput value={ttlValue} onChange={(e) => setTtlValue(e.target.value)} />
          </label>
        </Dialog>
      ) : null}

      {renameOpen ? (
        <Dialog
          title={t("value.renameDialogTitle")}
          width={420}
          onClose={() => setRenameOpen(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRenameOpen(false)} disabled={saving}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" onClick={() => void applyRename()} disabled={saving}>
                {t("common.save")}
              </Button>
            </>
          }
        >
          <label className="block t-13">
            <span className="mb-1 block text-muted">{t("value.newName")}</span>
            <TextInput value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          </label>
        </Dialog>
      ) : null}

      {addRowOpen && meta && meta.keyType !== "stream" ? (
        <RowDialog
          keyType={meta.keyType}
          busy={saving}
          onCancel={() => setAddRowOpen(false)}
          onSubmit={(cells) => void addRow(cells)}
        />
      ) : null}
    </section>
  );
}
