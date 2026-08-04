import { cn } from "@vibest/ui/lib/utils";
import type { ReactElement } from "react";

import vibestMarkUrl from "@/assets/vibest-mark.svg?url";

// Fills the corner desktop reserves for native traffic lights (see
// __root.tsx) so the browser doesn't just leave it blank.
export function BrandMark({ className }: { className?: string }): ReactElement {
  return (
    <div className={cn("flex items-center gap-1 select-none", className)}>
      <span
        aria-hidden="true"
        className="bg-foreground block size-3.5 shrink-0 [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat] [-webkit-mask-position:center] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:contain]"
        style={{ WebkitMaskImage: `url(${vibestMarkUrl})`, maskImage: `url(${vibestMarkUrl})` }}
      />
      <span className="text-xs font-medium tracking-tight">vibest</span>
    </div>
  );
}
