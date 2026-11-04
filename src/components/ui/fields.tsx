import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[12px] text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-7 w-full rounded-sm border border-border bg-base px-2 text-[12px] placeholder:text-muted read-only:opacity-60 ${className}`}
      {...rest}
    />
  );
}

export function NumberInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <TextInput type="number" className={className} {...rest} />;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`inline-flex select-none items-center gap-2 text-[12px] ${
        disabled ? "opacity-60" : "cursor-pointer"
      }`}
    >
      <span
        className="flex h-4 w-4 items-center justify-center rounded-[3px] border border-border bg-base"
        aria-hidden="true"
      >
        {checked ? <span className="h-2.5 w-2.5 rounded-sm bg-text" /> : null}
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function Radio({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`inline-flex select-none items-center gap-2 text-[12px] ${
        disabled ? "opacity-60" : "cursor-pointer"
      }`}
    >
      <span
        className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-base"
        aria-hidden="true"
      >
        {checked ? <span className="h-2.5 w-2.5 rounded-full bg-text" /> : null}
      </span>
      <input
        type="radio"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      {label}
    </label>
  );
}

/**
 * Mirrors BetterGroupbox: a group whose title is a checkbox; the body is
 * disabled while unchecked.
 */
export function CheckGroup({
  label,
  checked,
  onChange,
  children,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-sm border border-border p-3">
      <Checkbox label={label} checked={checked} onChange={onChange} />
      <div className={`mt-2 space-y-2 ${checked ? "" : "opacity-50"}`}>{children}</div>
    </section>
  );
}

export function Select({
  className = "",
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-7 w-full rounded-sm border border-border bg-base px-1.5 text-[12px] ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
