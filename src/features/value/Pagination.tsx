import { useEffect, useState } from "react";

import { useT } from "../../lib/i18n";

interface PaginationProps {
  page: number;
  pageCount: number | null;
  loaded: number;
  total: number | null;
  pageSize: number;
  prevDisabled: boolean;
  nextDisabled: boolean;
  onPrev: () => void;
  onNext: () => void;
  onGoTo: (page: number) => void;
}

/** Mirrors the original Pagination.qml: page indicator, jump box, prev/next. */
export default function Pagination({
  page,
  pageCount,
  loaded,
  total,
  pageSize,
  prevDisabled,
  nextDisabled,
  onPrev,
  onNext,
  onGoTo,
}: PaginationProps) {
  const t = useT();
  const [jump, setJump] = useState(String(page + 1));

  useEffect(() => {
    setJump(String(page + 1));
  }, [page]);

  const go = () => {
    const target = Number.parseInt(jump, 10);
    if (Number.isNaN(target)) return;
    const pageIndex = Math.max(0, target - 1);
    onGoTo(pageCount !== null ? Math.min(pageIndex, pageCount - 1) : pageIndex);
  };

  return (
    <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted">
      <button
        type="button"
        className="rounded border border-border px-2 py-0.5 text-text disabled:opacity-40"
        onClick={onPrev}
        disabled={prevDisabled}
      >
        {t("pagination.prev")}
      </button>
      <span>
        {t("pagination.page", { page: page + 1 })}
        {pageCount !== null ? ` ${t("pagination.of", { count: pageCount })}` : ""}
      </span>
      <button
        type="button"
        className="rounded border border-border px-2 py-0.5 text-text disabled:opacity-40"
        onClick={onNext}
        disabled={nextDisabled}
      >
        {t("pagination.next")}
      </button>
      <input
        className="w-16 rounded border border-border bg-base px-2 py-0.5 text-text outline-none"
        value={jump}
        onChange={(event) => setJump(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") go();
        }}
        aria-label={t("pagination.pageNumber")}
      />
      <button
        type="button"
        className="rounded border border-border px-2 py-0.5 text-text"
        onClick={go}
      >
        {t("pagination.goTo")}
      </button>
      <span className="ml-auto">
        {t("pagination.loaded", { loaded })}
        {total !== null ? ` / ${total}` : ""} · {t("pagination.perPage", { size: pageSize })}
      </span>
    </div>
  );
}
