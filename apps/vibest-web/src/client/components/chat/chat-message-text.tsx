import type { ComponentProps, ReactElement } from "react"

import { cn } from "../../lib/utils.ts"

export type ChatMessageTextProps = Omit<ComponentProps<"p">, "children"> & {
  text: string
  mentions?: readonly string[]
}

export function ChatMessageText({ text, mentions = [], className, ...props }: ChatMessageTextProps): ReactElement {
  const names = new Set(mentions.map((name) => `@${name}`))
  const parts = text.split(/(@[\p{L}\p{N}_.-]+)/u)

  return (
    <p className={cn("m-0 whitespace-pre-wrap break-words text-sm leading-[1.55]", className)} {...props}>
      {parts.map((part, index) => {
        if (index > 0 && !/(?:^|\s)$/.test(parts[index - 1] ?? "")) return part
        const mention = names.has(part) ? part : part.replace(/[.-]+$/, "")

        if (!names.has(mention)) return part

        return (
          <span key={`${index}-${part}`}>
            <span className="font-medium">{mention}</span>
            {part.slice(mention.length)}
          </span>
        )
      })}
    </p>
  )
}
