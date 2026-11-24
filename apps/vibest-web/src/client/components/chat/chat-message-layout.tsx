import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import type { ComponentProps, ReactElement } from "react"

import { cn } from "../../lib/utils.ts"

export type ChatMessageLayoutProps = useRender.ComponentProps<"article"> & {
  align?: "start" | "end"
}

export function ChatMessageLayout({
  align = "start",
  className,
  render,
  ...props
}: ChatMessageLayoutProps): ReactElement {
  const defaultProps = {
    "data-slot": "chat-message",
    "data-align": align,
    className: cn(
      "group/message relative grid scroll-m-8 grid-cols-1 items-start rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring has-[>[data-slot=chat-message-avatar]]:grid-cols-[auto_minmax(0,1fr)] has-[>[data-slot=chat-message-avatar]]:gap-x-2 has-[>[data-slot=chat-message-header]]:gap-y-1",
      className,
    ),
  }

  return useRender({
    defaultTagName: "article",
    render,
    props: mergeProps<"article">(defaultProps, props),
  })
}

export function ChatMessageAvatar({ className, ...props }: ComponentProps<"div">): ReactElement {
  return <div data-slot="chat-message-avatar" className={cn("col-start-1 row-start-2 w-7", className)} {...props} />
}

export function ChatMessageHeader({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-message-header"
      className={cn(
        "col-start-1 in-[[data-slot=chat-message]:has(>[data-slot=chat-message-avatar])]:col-start-2 row-start-1 px-1 font-medium text-muted-foreground text-xs group-data-[align=end]/message:justify-self-end",
        className,
      )}
      {...props}
    />
  )
}

export function ChatMessageContent({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-message-content"
      className={cn(
        "col-start-1 in-[[data-slot=chat-message]:has(>[data-slot=chat-message-avatar])]:col-start-2 row-start-2 flex min-w-0 flex-col gap-1 group-data-[align=end]/message:items-end",
        className,
      )}
      {...props}
    />
  )
}

export function ChatMessageFooter({ className, ...props }: ComponentProps<"div">): ReactElement {
  return (
    <div
      data-slot="chat-message-footer"
      className={cn("flex items-center gap-1.5 px-1 pt-0.5 text-[.625rem] text-muted-foreground", className)}
      {...props}
    />
  )
}
