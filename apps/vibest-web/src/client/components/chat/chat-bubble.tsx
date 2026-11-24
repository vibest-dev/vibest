import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { ComponentProps, ReactElement } from "react"

import { cn } from "../../lib/utils.ts"

export type ChatBubbleProps = useRender.ComponentProps<"div"> & {
  align?: "start" | "end"
  variant?: "default" | "muted"
  grouped?: boolean
}

export function ChatBubble({
  align = "start",
  variant = "default",
  grouped = false,
  className,
  render,
  ...props
}: ChatBubbleProps): ReactElement {
  const defaultProps = {
    "data-slot": "chat-bubble",
    "data-align": align,
    "data-variant": variant,
    "data-grouped": grouped || undefined,
    className: cn(
      "relative flex min-w-0 flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-foreground",
      variant === "default" ? "bg-foreground/12" : "bg-foreground/4",
      !grouped && (align === "end" ? "rounded-se-md" : "rounded-ss-md"),
      className,
    ),
  }

  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(defaultProps, props),
  })
}

export function ChatBubbleReactions({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="chat-bubble-reactions" className={cn("flex flex-wrap gap-1 px-0.5", className)} {...props} />
}
