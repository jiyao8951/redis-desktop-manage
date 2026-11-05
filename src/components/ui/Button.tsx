import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

const STYLES: Record<Variant, string> = {
  primary:
    "bg-accent text-white border-accent hover:bg-accent/90 active:bg-accent/80 disabled:opacity-50",
  secondary:
    "bg-base text-text border-border hover:bg-surface hover:border-muted/50 active:bg-win disabled:opacity-50",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface active:bg-win disabled:opacity-50",
  danger:
    "bg-transparent text-danger border-transparent hover:bg-danger/10 active:bg-danger/15 disabled:opacity-50",
};

export default function Button({
  variant = "secondary",
  className = "",
  children,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border px-2.5 text-[12px] leading-none transition-colors disabled:cursor-not-allowed ${STYLES[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
