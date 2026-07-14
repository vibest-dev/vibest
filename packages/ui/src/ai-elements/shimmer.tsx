import { cn } from "@vibest/ui/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
}

// Animated text shimmer via the tw-shimmer Tailwind utilities — the consuming
// app must `@import "tw-shimmer"` in its CSS entry.
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
}: TextShimmerProps) => {
  return (
    <Component
      className={cn("shimmer shimmer-invert text-muted-foreground inline-block", className)}
      style={{ "--shimmer-duration": `${duration * 1000}` } as CSSProperties}
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
