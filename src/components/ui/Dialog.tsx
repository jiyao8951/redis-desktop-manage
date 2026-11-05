import { useEffect, type ReactNode } from "react";

import { useT } from "../../lib/i18n";
import { Icon } from "./Icon";

export default function Dialog({
  title,
  width = 560,
  children,
  footer,
  onClose,
}: {
  title: string;
  width?: number;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  const t = useT();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[90vh] flex-col overflow-hidden rounded-lg border border-border bg-base shadow-2xl"
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
          <button
            type="button"
            className="rounded-sm p-1 text-muted transition-colors hover:bg-win hover:text-text"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-4 py-2.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
