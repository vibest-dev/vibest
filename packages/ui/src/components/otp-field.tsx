"use client";

import { OTPField as OTPFieldPrimitive } from "@base-ui/react/otp-field";
import { Separator } from "@vibest/ui/components/separator";
import { cn } from "@vibest/ui/lib/utils";
import type * as React from "react";

export function OTPField({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Root> & {
  size?: "default" | "lg";
}): React.ReactElement {
  return (
    <OTPFieldPrimitive.Root
      className={cn(
        "flex items-center gap-2 has-disabled:opacity-64 has-disabled:**:data-[slot=otp-field-input]:shadow-none has-disabled:**:data-[slot=otp-field-input]:before:shadow-none!",
        className,
      )}
      data-size={size}
      data-slot="otp-field"
      {...props}
    />
  );
}

export function OTPFieldInput({
  className,
  ...props
}: React.ComponentProps<typeof OTPFieldPrimitive.Input>): React.ReactElement {
  return (
    <OTPFieldPrimitive.Input
      className={cn(
        "border-input bg-background text-foreground ring-ring/24 focus-visible:border-ring focus-visible:ring-ring/24 aria-invalid:border-destructive/36 aria-invalid:focus-visible:border-destructive/64 aria-invalid:focus-visible:ring-destructive/16 dark:bg-input/32 dark:aria-invalid:focus-visible:ring-destructive/24 relative size-9 min-w-0 rounded-lg border text-center text-base leading-9 shadow-xs/5 transition-shadow outline-none not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-focus-visible:not-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] focus-visible:z-10 focus-visible:shadow-none focus-visible:ring-[3px] in-[[data-slot=otp-field][data-size=lg]]:size-10 in-[[data-slot=otp-field][data-size=lg]]:text-lg in-[[data-slot=otp-field][data-size=lg]]:leading-10 aria-invalid:shadow-none sm:size-8 sm:text-sm sm:leading-8 sm:in-[[data-slot=otp-field][data-size=lg]]:size-9 sm:in-[[data-slot=otp-field][data-size=lg]]:text-base sm:in-[[data-slot=otp-field][data-size=lg]]:leading-9 dark:not-focus-visible:not-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
        className,
      )}
      data-slot="otp-field-input"
      spellCheck={false}
      {...props}
    />
  );
}

export function OTPFieldSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>): React.ReactElement {
  return (
    <OTPFieldPrimitive.Separator
      render={
        <Separator
          className={cn(
            "bg-input rounded-full data-[orientation=horizontal]:h-0.5 data-[orientation=horizontal]:w-3",
            className,
          )}
          orientation="horizontal"
          {...props}
        />
      }
    />
  );
}

export { OTPFieldPrimitive };
