import { Predicate } from "effect"
import type { ReactElement, ReactNode } from "react"

import { cn } from "../../lib/utils.ts"
import { ChatBubbleReactions } from "./chat-bubble.tsx"
import { ChatMessageBubble, type ChatMessageBubbleProps } from "./chat-message-bubble.tsx"
import {
  ChatMessageAvatar,
  ChatMessageContent,
  ChatMessageFooter,
  ChatMessageHeader,
  ChatMessageLayout,
  type ChatMessageLayoutProps,
} from "./chat-message-layout.tsx"
import { ChatMessageText } from "./chat-message-text.tsx"

type ChatMessageAnimationProps = Pick<ChatMessageBubbleProps, "animateEntrance" | "highlighted" | "onAnimationComplete">

export type ChatMessageProps = Omit<ChatMessageLayoutProps, "align" | "children"> &
  ChatMessageAnimationProps & {
    side: "incoming" | "outgoing"
    author?: ReactNode
    avatar?: ReactNode
    grouped?: boolean
    lifted?: boolean
    children: ReactNode
    actions?: ReactNode
    reactions?: ReactNode
    footer?: ReactNode
    bubble?: boolean
    bubbleProps?: Omit<ChatMessageBubbleProps, "side" | "firstInGroup" | "children" | keyof ChatMessageAnimationProps>
  }

export function ChatMessage({
  side,
  author,
  avatar,
  grouped = false,
  lifted = false,
  children,
  actions,
  reactions,
  footer,
  bubble = true,
  bubbleProps,
  animateEntrance,
  highlighted,
  onAnimationComplete,
  ...props
}: ChatMessageProps): ReactElement {
  const own = side === "outgoing"

  return (
    <ChatMessageLayout align={own ? "end" : "start"} {...props}>
      {!own && !grouped && author && (
        <ChatMessageHeader className={lifted ? "invisible" : undefined}>{author}</ChatMessageHeader>
      )}
      {!own && avatar && (
        <ChatMessageAvatar className={lifted ? "invisible" : undefined}>{!grouped && avatar}</ChatMessageAvatar>
      )}
      <ChatMessageContent>
        {bubble ? (
          <div className={cn("flex w-full min-w-0 items-center gap-2", own && "flex-row-reverse")}>
            <div className="relative min-w-0 max-w-[83%] shrink">
              <ChatMessageBubble
                {...bubbleProps}
                side={side}
                firstInGroup={!grouped}
                animateEntrance={animateEntrance}
                highlighted={highlighted}
                onAnimationComplete={onAnimationComplete}
                className={cn(lifted && "invisible", bubbleProps?.className)}
              >
                {Predicate.isString(children) ? <ChatMessageText text={children} /> : children}
              </ChatMessageBubble>
            </div>
            {actions}
          </div>
        ) : (
          children
        )}
        {reactions && <ChatBubbleReactions>{reactions}</ChatBubbleReactions>}
        {footer && <ChatMessageFooter>{footer}</ChatMessageFooter>}
      </ChatMessageContent>
    </ChatMessageLayout>
  )
}
