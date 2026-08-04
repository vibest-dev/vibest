"use client";

import { Button } from "@vibest/ui/components/button";
import { cn } from "@vibest/ui/lib/utils";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-auto", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("p-4", className)} {...props} />
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, escapedFromLock, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  if (isAtBottom) {
    return null;
  }

  // `escapedFromLock` means the user actively scrolled away from the
  // auto-follow lock, so newer content has likely arrived below — surface the
  // button a little more strongly than the resting outline style.
  const variant = escapedFromLock ? "secondary" : "outline";

  return (
    <Button
      className={cn("absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full", className)}
      onClick={handleScrollToBottom}
      size="icon"
      type="button"
      variant={variant}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
};
