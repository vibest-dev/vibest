import { Button as ButtonPrimitive } from "@base-ui/react/button"
import type { ComponentProps, ReactElement } from "react"

import { cn } from "../../lib/utils.ts"

export function Composer({ className, ...props }: ComponentProps<"form">): ReactElement {
  return (
    <form
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col rounded-(--composer-radius) border border-input bg-background not-dark:bg-clip-padding pb-[calc(var(--composer-padding)-1px)] text-foreground shadow-xs/5 ring-ring/24 transition-shadow [--composer-padding:--spacing(2)] [--composer-radius:var(--radius-xl)] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--composer-radius)-1px)] not-has-disabled:not-has-[[data-slot=composer-input]:focus-visible]:before:shadow-[0_1px_--theme(--color-black/4%)] has-[[data-slot=composer-input]:focus-visible]:border-ring has-[[data-slot=composer-input]:focus-visible]:shadow-none has-[[data-slot=composer-input]:focus-visible]:ring-[3px] dark:bg-input/32 dark:not-has-disabled:not-has-[[data-slot=composer-input]:focus-visible]:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-slot="composer"
      {...props}
    />
  )
}

export function ComposerInput({ className, ...props }: ComponentProps<"textarea">): ReactElement {
  return (
    <textarea
      className={cn(
        "w-full min-h-11 max-h-44 resize-none bg-transparent px-3 pt-2.5 pb-1.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/72",
        className,
      )}
      data-slot="composer-input"
      {...props}
    />
  )
}

export function ComposerActions({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      className={cn("flex items-center justify-between gap-2 px-2 pt-1.5", className)}
      data-slot="composer-actions"
      {...props}
    />
  )
}

export function ComposerActionGroup({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div className={cn("flex items-center gap-1.5 min-w-0", className)} data-slot="composer-action-group" {...props} />
  )
}

export function ComposerSubmit({ className, ...props }: ButtonPrimitive.Props): ReactElement {
  return (
    <ButtonPrimitive
      className={cn(
        "relative inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-xs/5 outline-none transition-shadow not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-disabled:before:shadow-[0_1px_--theme(--color-white/16%)] hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      data-slot="composer-submit"
      type="submit"
      {...props}
    />
  )
}
