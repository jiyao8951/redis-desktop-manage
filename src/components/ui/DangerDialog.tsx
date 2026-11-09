import { useEffect, useState, type ReactNode } from "react";

import { useT } from "../../lib/i18n";
import Button from "./Button";
import { TextInput } from "./fields";
import { Icon } from "./Icon";

export interface DangerDialogProps {
  title: string;
  description?: ReactNode;
  /** Target server; hidden when the operation is not server-scoped. */
  serverName?: string | null;
  database?: number | null;
  /** Current key count when known; omitted entirely when unknown. */
  keyCount?: number | null;
  /** Marks an operation that affects the whole server (FLUSHALL level). */
  fullServer?: boolean;
  /**
   * When set, the user must type this text exactly before the confirm button
   * becomes enabled. Used for high-risk destructive operations.
   */
  requireText?: string | null;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Shared confirmation dialog for destructive Redis operations. Replaces
 * `window.confirm` so the target server, database, key count and severity are
 * always visible before the command runs.
 */
export default function DangerDialog({
  title,
  description,
  serverName,
  database,
  keyCount,
  fullServer = false,
  requireText,
  confirmLabel,
  busy = false,
  onConfirm,
  onClose,
}: DangerDialogProps) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const needsTyping = Boolean(requireText && requireText.length > 0);
  const matches = !needsTyping || typed.trim() === (requireText ?? "").trim();
  const canConfirm = matches && !busy;
  const hasTarget =
    Boolean(serverName) ||
    (database !== undefined && database !== null) ||
    (keyCount !== undefined && keyCount !== null);

  useEffect(() => {
    // Capture phase so Escape only closes this dialog; the parent Dialog (if
    // any) must stay open when this overlay sits above it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const submit = () => {
    if (!canConfirm) return;
    onConfirm();
  };

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-[60] flex items-center justify-center p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`flex max-h-[90vh] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-lg border bg-base shadow-2xl ${
          fullServer ? "border-danger" : "border-border"
        }`}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <header
          className={`flex shrink-0 items-center gap-2 border-b px-4 py-3 ${
            fullServer
              ? "border-danger/50 bg-danger/10 text-danger"
              : "border-border bg-surface text-text"
          }`}
        >
          <Icon name="alert" />
          <span className="min-w-0 flex-1 truncate t-14 font-semibold">{title}</span>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 t-13">
          {fullServer ? (
            <div className="rounded-md border border-danger bg-danger/10 px-3 py-2 text-danger">
              <div className="font-semibold">{t("danger.fullServer")}</div>
              <div className="mt-0.5 t-12">{t("danger.fullServerHint")}</div>
            </div>
          ) : null}

          {hasTarget ? (
            <div className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5">
              {serverName ? (
                <>
                  <span className="text-muted">{t("danger.serverLabel")}</span>
                  <span className="min-w-0 break-all font-mono">{serverName}</span>
                </>
              ) : null}
              {database !== null && database !== undefined ? (
                <>
                  <span className="text-muted">{t("danger.databaseLabel")}</span>
                  <span className="font-mono">db{database}</span>
                </>
              ) : null}
              {keyCount !== null && keyCount !== undefined ? (
                <>
                  <span className="text-muted">{t("danger.keyCountLabel")}</span>
                  <span className="font-mono">{t("danger.keyCount", { count: keyCount })}</span>
                </>
              ) : null}
            </div>
          ) : null}

          {description ? (
            <div className="whitespace-pre-wrap leading-5 text-text/90">{description}</div>
          ) : null}

          {needsTyping ? (
            <div>
              <div className="mb-1.5 text-muted">
                {t("danger.typeToConfirm", { text: requireText ?? "" })}
              </div>
              <TextInput
                autoFocus
                value={typed}
                spellCheck={false}
                placeholder={requireText ?? ""}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
              />
            </div>
          ) : null}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-4 py-2.5">
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={!canConfirm}
            autoFocus={!needsTyping}
          >
            {busy ? t("common.saving") : (confirmLabel ?? t("danger.confirm"))}
          </Button>
        </footer>
      </div>
    </div>
  );
}
