"use client";

import * as React from "react";
import { Accordion as BaseAccordion } from "@base-ui/react/accordion";
import { IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/* ─── Types ─────────────────────────────────────────────────── */

export type AccordionType = "single" | "multiple";

export type AccordionVariant = "bordered" | "separated" | "minimal" | "faq";

export interface AccordionProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "defaultValue" | "onChange"> {
  type?: AccordionType;
  variant?: AccordionVariant;
  value?: string | string[];
  defaultValue?: string | string[];
  /** For type="single": allow closing the open item, leaving none open. Default true. */
  collapsible?: boolean;
  onValueChange?: (value: string | string[]) => void;
  children: React.ReactNode;
}

export interface AccordionItemProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "value"> {
  value: string;
  disabled?: boolean;
}

export type AccordionTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export type AccordionContentProps = React.HTMLAttributes<HTMLDivElement>;

/* ─── Context (variant + single-collapsible policy only) ─────── */

type AccordionContextValue = {
  variant: AccordionVariant;
  type: AccordionType;
  collapsible: boolean;
};

const AccordionContext = React.createContext<AccordionContextValue | null>(null);

function useAccordionContext() {
  const ctx = React.useContext(AccordionContext);
  if (!ctx) throw new Error("Accordion compound components must be used within <Accordion>");
  return ctx;
}

/* ─── Helpers ───────────────────────────────────────────────── */

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/* ─── Variant Styles ────────────────────────────────────────── */

const rootVariantClasses: Record<AccordionVariant, string> = {
  bordered: cn(
    "overflow-hidden rounded-[var(--primitive-radius-surface)] border",
    "border-[var(--primitive-border-subtle)]",
  ),
  separated: "flex flex-col gap-2",
  minimal: "flex flex-col",
  faq: "flex flex-col",
};

const itemVariantClasses: Record<AccordionVariant, string> = {
  bordered: cn("border-b last:border-b-0", "border-[var(--primitive-border-subtle)]"),
  // Painted by data-surface="panel".
  separated: "overflow-hidden rounded-[var(--primitive-radius-surface)]",
  minimal: cn("border-b last:border-b-0", "border-[var(--primitive-border-subtle)]"),
  faq: cn("border-b last:border-b-0", "border-[var(--primitive-border-subtle)]"),
};

const triggerPaddingClasses: Record<AccordionVariant, string> = {
  bordered: "px-4 py-4 text-[15px]",
  separated: "px-4 py-4 text-[15px]",
  minimal: "px-0.5 py-4 text-[15px]",
  faq: "px-1 py-5 text-base",
};

const contentPaddingClasses: Record<AccordionVariant, string> = {
  bordered: "px-4 pb-4 text-[14px]",
  separated: "px-4 pb-4 text-[14px]",
  minimal: "px-0.5 pb-4 text-[14px]",
  faq: "px-1 pb-6 text-[15px]",
};

const triggerHoverClasses: Record<AccordionVariant, string> = {
  bordered: "hover:bg-[var(--primitive-surface-hover)]",
  separated: "hover:bg-[var(--primitive-surface-hover)]",
  minimal: "",
  faq: "",
};

const panelMotionClass = cn(
  "h-[var(--accordion-panel-height)] overflow-hidden",
  "transition-[height,opacity] duration-[var(--primitive-motion-moderate)] ease-[var(--primitive-ease,cubic-bezier(0.23,1,0.32,1))]",
  "data-[starting-style]:h-0 data-[starting-style]:opacity-0",
  "data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-[var(--primitive-motion-moderate-exit)]",
  "motion-reduce:transition-none motion-reduce:data-[starting-style]:opacity-100 motion-reduce:data-[ending-style]:opacity-100",
);

/* ─── <Accordion> ───────────────────────────────────────────── */

export const Accordion = React.forwardRef<HTMLDivElement, AccordionProps>(
  (
    {
      type = "single",
      variant = "minimal",
      value: controlledValue,
      defaultValue,
      collapsible = true,
      onValueChange,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const ctx = React.useMemo<AccordionContextValue>(
      () => ({ variant, type, collapsible }),
      [variant, type, collapsible],
    );

    const [uncontrolled, setUncontrolled] = React.useState(() => toArray(defaultValue));
    const isControlled = controlledValue !== undefined;
    const value = isControlled ? toArray(controlledValue) : uncontrolled;

    const handleValueChange = React.useCallback(
      (next: string[]) => {
        if (type === "single" && !collapsible && next.length === 0) return;
        if (!isControlled) setUncontrolled(next);
        onValueChange?.(type === "multiple" ? next : (next[0] ?? ""));
      },
      [type, collapsible, isControlled, onValueChange],
    );

    return (
      <AccordionContext.Provider value={ctx}>
        <BaseAccordion.Root data-wensity-primitive=""
          ref={ref}
          multiple={type === "multiple"}
          value={value}
          onValueChange={handleValueChange}
          keepMounted
          data-slot="accordion"
          data-variant={variant}
          className={cn(rootVariantClasses[variant], className)}
          {...props}
        >
          {children}
        </BaseAccordion.Root>
      </AccordionContext.Provider>
    );
  },
);
Accordion.displayName = "Accordion";

/* ─── <AccordionItem> ───────────────────────────────────────── */

export const AccordionItem = React.forwardRef<HTMLDivElement, AccordionItemProps>(
  ({ value, disabled = false, className, children, ...props }, ref) => {
    const { variant } = useAccordionContext();

    return (
      <BaseAccordion.Item
        ref={ref}
        value={value}
        disabled={disabled}
        data-slot="accordion-item"
        data-surface={variant === "separated" ? "panel" : undefined}
        className={cn(itemVariantClasses[variant], className)}
        {...props}
      >
        {children}
      </BaseAccordion.Item>
    );
  },
);
AccordionItem.displayName = "AccordionItem";

/* ─── <AccordionTrigger> ────────────────────────────────────── */

export const AccordionTrigger = React.forwardRef<
  HTMLButtonElement,
  AccordionTriggerProps
>(({ className, children, ...props }, ref) => {
  const { variant } = useAccordionContext();

  return (
    <BaseAccordion.Header className="flex">
      <BaseAccordion.Trigger
        ref={ref}
        data-slot="accordion-trigger"
        className={cn(
          "group/accordion-trigger flex w-full flex-1 items-center justify-between gap-3 rounded-[var(--primitive-radius-control-sm)] text-left",
          "font-medium leading-none tracking-[-0.01em] text-[var(--foreground)]",
          "outline-none transition-[background-color,color] duration-[var(--primitive-motion-fast)] ease-[var(--primitive-ease,cubic-bezier(0.23,1,0.32,1))]",
          "focus-visible:ring-2 focus-visible:ring-[var(--primitive-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]",
          "disabled:pointer-events-none disabled:opacity-45",
          triggerPaddingClasses[variant],
          triggerHoverClasses[variant],
          className,
        )}
        {...props}
      >
        <span className="flex-1">{children}</span>
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 items-center justify-center text-[var(--muted-foreground)]",
            "transition-transform duration-[var(--primitive-motion-moderate)] ease-[var(--primitive-ease,cubic-bezier(0.23,1,0.32,1))]",
            "group-data-[panel-open]/accordion-trigger:rotate-180",
            "motion-reduce:transition-none",
          )}
        >
          <IconChevronDown className="size-4" stroke={1.9} />
        </span>
      </BaseAccordion.Trigger>
    </BaseAccordion.Header>
  );
});
AccordionTrigger.displayName = "AccordionTrigger";

/* ─── <AccordionContent> ────────────────────────────────────── */

export const AccordionContent = React.forwardRef<HTMLDivElement, AccordionContentProps>(
  ({ className, children, ...props }, ref) => {
    const { variant } = useAccordionContext();

    return (
      <BaseAccordion.Panel
        ref={ref}
        keepMounted
        data-slot="accordion-content"
        className={cn(panelMotionClass, className)}
        {...props}
      >
        <div
          className={cn(
            "leading-6 text-[var(--primitive-text-secondary)]",
            contentPaddingClasses[variant],
          )}
        >
          {children}
        </div>
      </BaseAccordion.Panel>
    );
  },
);
AccordionContent.displayName = "AccordionContent";
