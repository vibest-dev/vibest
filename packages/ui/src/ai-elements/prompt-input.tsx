"use client";

import { Button } from "@vibest/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vibest/ui/components/select";
import { Textarea } from "@vibest/ui/components/textarea";
import { cn } from "@vibest/ui/lib/utils";
import type { ChatStatus } from "ai";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, KeyboardEventHandler } from "react";
import { Children, useMemo } from "react";

export type PromptInputProps = HTMLAttributes<HTMLFormElement>;

export const PromptInput = ({ className, ...props }: PromptInputProps) => (
  <form
    className={cn(
      "bg-background w-full divide-y rounded-xl",
      "[--composer-ring:rgba(0,0,0,0.05)] dark:[--composer-ring:rgba(255,255,255,0.08)]",
      "shadow-[0_18px_47px_0_rgba(0,0,0,0.03),0_7.5px_19px_0_rgba(0,0,0,0.02),0_4px_10.5px_0_rgba(0,0,0,0.02),0_2.3px_5.8px_0_rgba(0,0,0,0.01),0_1.2px_3.1px_0_rgba(0,0,0,0.01),0_0.5px_1.3px_0_rgba(0,0,0,0.01),0_0_0_1px_var(--composer-ring)]",
      className,
    )}
    {...props}
  />
);

export type PromptInputTextareaProps = ComponentProps<typeof Textarea> & {
  minHeight?: number;
  maxHeight?: number;
};

const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
  if (e.key === "Enter") {
    // Don't submit if IME composition is in progress
    if (e.nativeEvent.isComposing) {
      return;
    }

    if (e.shiftKey) {
      // Allow newline
      return;
    }

    // Submit on Enter (without Shift)
    e.preventDefault();
    const form = e.currentTarget.form;
    if (form) {
      form.requestSubmit();
    }
  }
};

export const PromptInputTextarea = ({
  onChange,
  className,
  placeholder = "What would you like to know?",
  minHeight: _minHeight = 48,
  maxHeight: _maxHeight = 164,
  ...props
}: PromptInputTextareaProps) => {
  return (
    <Textarea
      className={cn(
        "w-full resize-none rounded-none border-none p-3 shadow-none ring-0 outline-none",
        "field-sizing-content max-h-[6lh] bg-transparent dark:bg-transparent",
        "focus-visible:ring-0",
        className,
      )}
      name="message"
      onChange={(e) => {
        onChange?.(e);
      }}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputToolbarProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputToolbar = ({ className, ...props }: PromptInputToolbarProps) => (
  <div className={cn("flex items-end justify-between p-2 pt-1", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div
    className={cn("flex items-center gap-1", "[&_button:first-child]:rounded-bl-xl", className)}
    {...props}
  />
);

export type PromptInputButtonProps = ComponentProps<typeof Button>;

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  ...props
}: PromptInputButtonProps) => {
  const newSize = (size ?? Children.count(props.children) > 1) ? "default" : "icon";

  return (
    <Button
      className={cn(
        "shrink-0 gap-1.5 rounded-lg",
        variant === "ghost" && "text-muted-foreground",
        newSize === "default" && "px-3",
        className,
      )}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );
};

export type PromptInputSubmitProps = ComponentProps<typeof Button> & {
  status?: ChatStatus;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "sm",
  status,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const Icon = useMemo(() => {
    switch (status) {
      case "submitted":
        return <ArrowUpIcon className="size-4" />;
      case "streaming":
        return <SquareIcon className="size-4" />;
      case "error":
        return <XIcon className="size-4" />;
      default:
        return <ArrowUpIcon className="size-4" />;
    }
  }, [status]);

  return (
    <Button
      size={size}
      type="submit"
      variant={variant}
      className={cn("has-[>svg]:px-2", className)}
      {...props}
    >
      {children ?? Icon}
    </Button>
  );
};

export const PromptInputModelSelect = Select;

export const PromptInputModelSelectTrigger = SelectTrigger;

export const PromptInputModelSelectValue = SelectValue;

export const PromptInputModelSelectContent = SelectContent;

export const PromptInputModelSelectItem = SelectItem;
