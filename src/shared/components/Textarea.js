"use client";

import { cn } from "@/shared/utils/cn";

export default function Textarea({
  label,
  placeholder,
  value,
  onChange,
  hint,
  error,
  disabled = false,
  rows = 8,
  className,
  textareaClassName,
  ...props
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={props.id} className="text-sm font-medium text-text-main">
          {label}
        </label>
      )}
      <textarea
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        disabled={disabled}
        rows={rows}
        className={cn(
          "w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] font-mono leading-relaxed resize-y",
          "border border-transparent placeholder-text-muted/70",
          "focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40",
          "transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed",
          "text-[16px] sm:text-xs",
          error && "ring-1 ring-red-500 focus:ring-2 focus:ring-red-500/40 border-red-500/40",
          textareaClassName
        )}
        {...props}
      />
      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </p>
      )}
      {hint && !error && (
        <p className="text-xs text-text-muted">{hint}</p>
      )}
    </div>
  );
}
