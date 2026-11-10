"use client";
/** @registry name="checkbox" type="ui" title="Checkbox" description="Native checkbox with label, description, indeterminate state and sizes; CheckboxGroup with select-all." */

import { cva } from "class-variance-authority";
import { useCallback, useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { cn, focusRing } from "@/ui/lib/knowns/utils";

export type CheckboxSize = "sm" | "md";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  label?: ReactNode;
  description?: ReactNode;
  /** Partly checked: shows a dash; screen readers hear "mixed". Clicking still toggles checked. */
  indeterminate?: boolean;
  /** 14 or 16px box. */
  size?: CheckboxSize;
  ref?: Ref<HTMLInputElement>;
}

const BOX: Record<CheckboxSize, { box: string; input: string; glyph: string; text: string; desc: string; pad: string }> = {
  sm: { box: "size-3.5", input: "size-3.5 rounded-[4px]", glyph: "size-2.5", text: "text-[12.5px] gap-2", desc: "text-[12px]", pad: "pt-[3px]" },
  md: { box: "size-4", input: "size-4 rounded-[5px]", glyph: "size-3", text: "text-[13.5px] gap-2.5", desc: "text-[12.5px]", pad: "pt-0.5" },
};

/** The input as a cva map. Checked and indeterminate take their colour from `--kn-accent` (default `--primary`). */
export const checkboxVariants = cva(
  [
    "peer cursor-pointer appearance-none bg-card shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_24%,transparent),0_1px_1px_rgb(0_0_0/0.05)] transition-[background-color,box-shadow] duration-150 ease-out",
    "checked:bg-[color:var(--kn-accent,var(--primary))] checked:shadow-[0_0_0_1px_var(--kn-accent,var(--primary))] indeterminate:bg-[color:var(--kn-accent,var(--primary))] indeterminate:shadow-[0_0_0_1px_var(--kn-accent,var(--primary))]",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ],
  { variants: { size: { sm: BOX.sm.input, md: BOX.md.input } }, defaultVariants: { size: "md" } },
);

/** A native checkbox, restyled. Clicking the label toggles it. */
export function Checkbox({ label, description, indeterminate = false, size = "md", className, ref, ...rest }: CheckboxProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      inner.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
    },
    [ref],
  );
  // `indeterminate` only exists as a DOM property; the native input then reports aria-checked="mixed".
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const s = BOX[size];
  const box = (
    <span className={cn("relative grid flex-none place-items-center", s.box)}>
      <input
        ref={setRef}
        type="checkbox"
        className={cn(checkboxVariants({ size }), focusRing)}
        {...rest}
      />
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute scale-90 text-[color:var(--kn-accent-foreground,var(--primary-foreground))] opacity-0 transition-[opacity,scale] duration-150 ease-out peer-[:checked:not(:indeterminate)]:scale-100 peer-[:checked:not(:indeterminate)]:opacity-100",
          s.glyph,
        )}
      >
        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn("pointer-events-none absolute scale-x-90 text-[color:var(--kn-accent-foreground,var(--primary-foreground))] opacity-0 transition-[opacity,scale] duration-150 ease-out peer-indeterminate:scale-x-100 peer-indeterminate:opacity-100", s.glyph)}
      >
        <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </span>
  );
  if (!label) return <span className={cn("inline-flex", className)}>{box}</span>;
  return (
    <label className={cn("flex cursor-pointer items-start has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted-foreground", s.text, className)}>
      <span className={s.pad}>{box}</span>
      <span className="flex flex-col">
        <span className="font-medium leading-snug">{label}</span>
        {description && <span className={cn("text-muted-foreground", s.desc)}>{description}</span>}
      </span>
    </label>
  );
}

/* ── CheckboxGroup ── */

export interface CheckboxOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/** State of a "select all" box: all enabled options on, some, or none. Disabled options don't count. */
export function selectAllState(values: string[], options: Pick<CheckboxOption, "value" | "disabled">[]): { checked: boolean; indeterminate: boolean } {
  const enabled = options.filter((o) => !o.disabled);
  const on = enabled.filter((o) => values.includes(o.value)).length;
  return { checked: enabled.length > 0 && on === enabled.length, indeterminate: on > 0 && on < enabled.length };
}

/** What "select all" does: turn every enabled option on, or off when all are on. Disabled ones keep their value. */
export function toggleAll(values: string[], options: Pick<CheckboxOption, "value" | "disabled">[]): string[] {
  const enabled = options.filter((o) => !o.disabled).map((o) => o.value);
  const allOn = enabled.length > 0 && enabled.every((v) => values.includes(v));
  const kept = values.filter((v) => !enabled.includes(v));
  if (allOn) return kept;
  // Values that aren't options stay first; options follow in their own order.
  const foreign = kept.filter((v) => !options.some((o) => o.value === v));
  return [...foreign, ...options.map((o) => o.value).filter((v) => kept.includes(v) || enabled.includes(v))];
}

export interface CheckboxGroupProps {
  legend: ReactNode;
  description?: ReactNode;
  options: CheckboxOption[];
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (values: string[]) => void;
  /** Label of a parent row that checks or clears every option; it shows a dash when only some are on. */
  selectAll?: string;
  /** Submitted with forms: one entry per checked value. */
  name?: string;
  size?: CheckboxSize;
  disabled?: boolean;
  className?: string;
}

/** A labelled set of checkboxes on fieldset/legend, with an optional "select all" row. */
export function CheckboxGroup({ legend, description, options, value, defaultValue = [], onValueChange, selectAll, name, size = "md", disabled, className }: CheckboxGroupProps) {
  const [local, setLocal] = useState<string[]>(defaultValue);
  const values = value ?? local;
  const set = (next: string[]) => {
    if (value === undefined) setLocal(next);
    onValueChange?.(next);
  };
  const descId = useId();
  const all = selectAllState(values, options);

  return (
    <fieldset disabled={disabled} aria-describedby={description ? descId : undefined} className={cn("m-0 flex min-w-0 flex-col gap-2.5 border-0 p-0", className)}>
      <legend className="mb-0.5 p-0 text-[13px] font-medium">{legend}</legend>
      {description && (
        <p id={descId} className="-mt-1.5 text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {selectAll && (
        <Checkbox size={size} label={selectAll} checked={all.checked} indeterminate={all.indeterminate} onChange={() => set(toggleAll(values, options))} />
      )}
      <div className={cn("flex flex-col gap-2.5", selectAll && (size === "sm" ? "pl-5.5" : "pl-6.5"))}>
        {options.map((o) => (
          <Checkbox
            key={o.value}
            size={size}
            name={name}
            value={o.value}
            label={o.label}
            description={o.description}
            disabled={o.disabled}
            checked={values.includes(o.value)}
            onChange={(e) => set(e.target.checked ? [...values.filter((v) => v !== o.value), o.value] : values.filter((v) => v !== o.value))}
          />
        ))}
      </div>
    </fieldset>
  );
}
