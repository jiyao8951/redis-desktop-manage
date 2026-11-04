import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

const STYLES: Record<Variant, string> = {
  primary: "bg-accent text-white border-accent hover:brightness-110 disabled:opacity-50",
  secondary: "bg-base text-text border-border hover:bg-surface disabled:opacity-50",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface disabled:opacity-50",
  danger: "bg-transparent text-danger border-transparent hover:bg-surface disabled:opacity-50",
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
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-sm border px-2.5 text-[12px] leading-none transition-colors ${STYLES[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
