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
      <span className="mb-1.5 block t-12 font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block t-12 leading-4 text-muted">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-[var(--ui-control-lg)] w-full rounded-sm border border-border bg-base px-2.5 t-13 transition-colors placeholder:text-muted hover:border-muted/50 focus:border-highlight focus:outline-none read-only:opacity-60 ${className}`}
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
      className={`inline-flex select-none items-center gap-2 t-13 ${
        disabled ? "opacity-60" : "cursor-pointer"
      }`}
    >
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-[3px] border t-11 font-semibold transition-colors ${
          checked ? "border-highlight bg-highlight text-white" : "border-border bg-base"
        }`}
        aria-hidden="true"
      >
        {checked ? "✓" : null}
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
      className={`inline-flex select-none items-center gap-2 t-13 ${
        disabled ? "opacity-60" : "cursor-pointer"
      }`}
    >
      <span
        className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-base"
        aria-hidden="true"
      >
        {checked ? <span className="h-2 w-2 rounded-full bg-highlight" /> : null}
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
    <section className="rounded-md border border-border bg-surface/40 p-4">
      <Checkbox label={label} checked={checked} onChange={onChange} />
      <div className={`mt-3 space-y-3 ${checked ? "" : "pointer-events-none opacity-50"}`}>
        {children}
      </div>
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
      className={`h-[var(--ui-control-lg)] w-full rounded-sm border border-border bg-base px-2 t-13 transition-colors hover:border-muted/50 focus:border-highlight focus:outline-none ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}
