import type { Html } from "@effect/ui/html"

export type BadgeVariant = "default" | "secondary" | "outline" | "info" | "success" | "warning" | "error"

export type ButtonVariant = "default" | "outline" | "secondary" | "ghost"

export type ButtonSize = "xs" | "sm" | "icon-xs"

const BADGE_VARIANT_CLASSES: Readonly<Record<BadgeVariant, string>> = {
  info: "border-transparent bg-info/12 text-info-foreground",
  success: "border-transparent bg-success/12 text-success-foreground",
  warning: "border-transparent bg-warning/15 text-warning-foreground",
  error: "border-transparent bg-destructive/15 text-destructive-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  default: "border-transparent bg-primary text-primary-foreground",
  outline: "border-border bg-transparent text-foreground",
}

const BUTTON_VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  outline: "border-input bg-background text-foreground hover:bg-accent",
  secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "border-transparent bg-transparent text-foreground hover:bg-accent",
  default: "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
}

const BUTTON_SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  "icon-xs": "size-6 p-0",
  sm: "h-7 px-2.5 text-xs",
  xs: "h-6 px-2 text-[11px]",
}

export function badgeClass(variant: BadgeVariant = "outline", extra?: string): string {
  const base =
    "inline-flex items-center justify-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap shrink-0"

  const variantCls = BADGE_VARIANT_CLASSES[variant]

  return extra ? `${base} ${variantCls} ${extra}` : `${base} ${variantCls}`
}

export function buttonClass(variant: ButtonVariant = "default", size: ButtonSize = "xs", extra?: string): string {
  const base =
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border text-xs font-medium whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:opacity-50"

  const variantCls = BUTTON_VARIANT_CLASSES[variant]
  const sizeCls = BUTTON_SIZE_CLASSES[size]

  return extra ? `${base} ${variantCls} ${sizeCls} ${extra}` : `${base} ${variantCls} ${sizeCls}`
}

export const Frame = <M>(h: Html.H<M>, extra?: string) =>
  h.div.class("relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-muted/72 p-1", extra)

export const FrameHeader = <M>(h: Html.H<M>, extra?: string) =>
  h.header.class("flex flex-row items-center justify-between gap-2 px-3 py-1.5", extra)

export const FrameTitle = <M>(h: Html.H<M>, extra?: string) =>
  h.div.class("text-xs font-semibold tracking-tight text-foreground", extra)

export const FramePanel = <M>(h: Html.H<M>, extra?: string) =>
  h.div.class(
    "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xs/5",
    extra,
  )

export const Badge = <M>(h: Html.H<M>, variant: BadgeVariant = "outline", extra?: string) =>
  h.span.class(badgeClass(variant, extra))

export const EmptyState = <M>(h: Html.H<M>, title: string, description: string) =>
  h.div
    .class("flex flex-col items-center justify-center gap-1 px-4 py-8 text-center")
    .children(
      h.div.class("text-xs font-semibold text-foreground").children(title),
      h.div.class("text-xs text-muted-foreground").children(description),
    )

export const TabsListClass =
  "relative inline-flex items-center justify-center rounded-lg bg-muted p-0.5 text-muted-foreground"

export const TabsTabClass =
  "relative inline-flex cursor-pointer items-center justify-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors outline-none data-[active]:bg-background data-[active]:text-foreground data-[active]:shadow-xs disabled:pointer-events-none disabled:opacity-40"
