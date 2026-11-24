import { motion, useReducedMotion } from "motion/react"
import type { ReactElement } from "react"

import { cn } from "../../lib/utils.ts"
import { ChatBubble, type ChatBubbleProps } from "./chat-bubble.tsx"

export type ChatMessageBubbleProps = Omit<ChatBubbleProps, "align" | "variant" | "grouped" | "render"> & {
  side: "incoming" | "outgoing"
  firstInGroup?: boolean | undefined
  animateEntrance?: boolean | undefined
  highlighted?: boolean | undefined
  onAnimationComplete?: (() => void) | undefined
}

export function ChatMessageBubble({
  side,
  firstInGroup = true,
  animateEntrance = false,
  highlighted = false,
  children,
  className,
  onAnimationComplete,
  ...props
}: ChatMessageBubbleProps): ReactElement {
  const reduceMotion = useReducedMotion()

  const entranceOrigin =
    side === "outgoing" ? "origin-top-right rtl:origin-top-left" : "origin-top-left rtl:origin-top-right"

  return (
    <ChatBubble
      {...props}
      align={side === "outgoing" ? "end" : "start"}
      variant={side === "outgoing" ? "default" : "muted"}
      grouped={!firstInGroup}
      data-slot="chat-message-bubble"
      className={cn(highlighted ? "origin-center" : entranceOrigin, className)}
      render={
        <motion.div
          initial={animateEntrance && !reduceMotion ? { transform: "scale(0.92)" } : false}
          animate={highlighted && !reduceMotion ? "attention" : "rest"}
          variants={{
            rest: {
              transform: "scale(1)",
              transition: reduceMotion ? { duration: 0 } : { type: "spring", duration: 0.35, bounce: 0.45 },
            },
            attention: {
              transform: ["scale(1)", "scale(1.05)", "scale(1)"],
              transition: {
                duration: 0.42,
                times: [0, 0.28, 1],
                ease: [
                  [0.16, 1, 0.3, 1],
                  [0.34, 1.56, 0.64, 1],
                ],
              },
            },
          }}
          {...(onAnimationComplete !== undefined && { onAnimationComplete })}
        />
      }
    >
      {children}
      {highlighted && (
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-foreground/25 ring-offset-2 ring-offset-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 0.42, times: [0, 0.28, 1], ease: "easeOut" }}
        />
      )}
    </ChatBubble>
  )
}
