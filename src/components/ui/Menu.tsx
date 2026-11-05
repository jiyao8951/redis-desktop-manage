import { useEffect, useRef, type CSSProperties } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  key: string;
  label: string;
  shortcut?: string;
  icon?: IconName;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  onClick: () => void;
}

export default function Menu({
  items,
  onClose,
  className = "",
  style,
}: {
  items: MenuItem[];
  onClose: () => void;
  className?: string;
  /** Inline positioning for menus anchored outside their parent (e.g. tab bar). */
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onPointerDown);
      window.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className={`absolute z-30 max-h-[70vh] min-w-[200px] max-w-[340px] overflow-y-auto rounded-md border border-border bg-base p-1 text-text shadow-xl ${className}`}
      style={style}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item) => (
        <div key={item.key}>
          {item.separatorBefore ? <div className="mx-1 my-1 h-px bg-border" /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`flex min-h-[var(--ui-control)] w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left t-13 leading-5 transition-colors ${
              item.disabled
                ? "cursor-default text-muted"
                : item.danger
                  ? "hover:bg-danger/10 hover:text-danger"
                  : "hover:bg-surface"
            }`}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick();
            }}
          >
            {item.icon ? (
              <Icon name={item.icon} className="shrink-0 opacity-80" />
            ) : (
              <span className="w-[14px] shrink-0" />
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut ? (
              <span className="ml-2 shrink-0 t-12 tracking-wide text-muted">
                {item.shortcut}
              </span>
            ) : null}
          </button>
        </div>
      ))}
    </div>
  );
}
