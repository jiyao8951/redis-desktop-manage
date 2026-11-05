import { useEffect, useState } from "react";

import Button from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
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
    <div className="flex items-center gap-2 border-t border-border bg-surface/40 px-3 py-1.5 text-[11px] text-muted">
      <Button variant="secondary" onClick={onPrev} disabled={prevDisabled}>
        <Icon name="chevron-left" className="h-3.5 w-3.5" />
        {t("pagination.prev")}
      </Button>
      <span className="font-mono">
        {t("pagination.page", { page: page + 1 })}
        {pageCount !== null ? ` ${t("pagination.of", { count: pageCount })}` : ""}
      </span>
      <Button variant="secondary" onClick={onNext} disabled={nextDisabled}>
        {t("pagination.next")}
        <Icon name="chevron-right" className="h-3.5 w-3.5" />
      </Button>
      <input
        className="h-7 w-16 rounded-sm border border-border bg-base px-2 font-mono text-[11px] text-text outline-none hover:border-muted/50 focus:border-highlight/60"
        value={jump}
        onChange={(event) => setJump(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") go();
        }}
        aria-label={t("pagination.pageNumber")}
      />
      <Button variant="ghost" onClick={go}>
        {t("pagination.goTo")}
      </Button>
      <span className="ml-auto font-mono">
        {t("pagination.loaded", { loaded })}
        {total !== null ? ` / ${total}` : ""} · {t("pagination.perPage", { size: pageSize })}
      </span>
    </div>
  );
}
