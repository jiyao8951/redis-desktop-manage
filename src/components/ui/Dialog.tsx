import type { ReactNode } from "react";

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
  return (
    <div
      className="dialog-backdrop fixed inset-0 z-40 flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[86vh] flex-col rounded-sm border border-border bg-win shadow-2xl"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-[12px] font-semibold">{title}</span>
          <button
            type="button"
            className="rounded-sm p-1 hover:bg-surface"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
