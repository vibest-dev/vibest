"use client";

import type { VariantProps } from "class-variance-authority";

import { ToggleGroup as ToggleGroupPrimitive } from "@ark-ui/react/toggle-group";
import { toggleVariants } from "@vibest/ui/components/toggle";
import { cn } from "@vibest/ui/lib/utils";
import * as React from "react";

const ToggleGroupExtendContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  ToggleGroupPrimitive.RootProps & VariantProps<typeof toggleVariants>
>(({ className, variant, size, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    data-variant={variant}
    data-size={size}
    className={cn(
      "group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs",
      className,
    )}
    {...props}
  >
    <ToggleGroupExtendContext.Provider value={{ variant, size }}>
      {children}
    </ToggleGroupExtendContext.Provider>
  </ToggleGroupPrimitive.Root>
));
ToggleGroup.displayName = "ToggleGroup";

const ToggleGroupContext = ToggleGroupPrimitive.Context;

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  ToggleGroupPrimitive.ItemProps & VariantProps<typeof toggleVariants>
>(({ className, variant, size, ...props }, ref) => {
  const context = React.useContext(ToggleGroupExtendContext);

  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      data-variant={context.variant || variant}
      data-size={context.size || size}
      className={cn(
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        "min-w-0 flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:border-l-0 data-[variant=outline]:first:border-l",
        className,
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = "ToggleGroupItem";

const ToggleGroupRootProvider = ToggleGroupPrimitive.RootProvider;

export { ToggleGroup, ToggleGroupContext, ToggleGroupItem, ToggleGroupRootProvider };

export {
  type ToggleGroupValueChangeDetails,
  useToggleGroup,
  useToggleGroupContext,
} from "@ark-ui/react/toggle-group";
