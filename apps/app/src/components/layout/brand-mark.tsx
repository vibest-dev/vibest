import { cn } from "@vibest/ui/lib/utils";
import type { ReactElement } from "react";

import vibestMarkUrl from "@/assets/vibest-mark.svg?url";

// Fills the sidebar row macOS gives to native traffic lights (see
// app-sidebar.tsx). `size-4` + `gap-2` + `text-sm` are the sidebar menu
// button's own icon/label metrics, so it reads as the row above the menu
// rather than as a differently-scaled header.
export function BrandMark({ className }: { className?: string }): ReactElement {
  return (
    <div className={cn("flex items-center gap-2 select-none", className)}>
      <span
        aria-hidden="true"
        className="bg-foreground block size-4 shrink-0 [mask-size:contain] [mask-position:center] [mask-repeat:no-repeat] [-webkit-mask-position:center] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:contain]"
        // Quoted, and not optional: dev serves this as a data URI whose own
        // single quotes are illegal inside a bare `url()`, so the browser drops
        // the whole declaration and the mark renders as a filled square.
        style={{ WebkitMaskImage: `url("${vibestMarkUrl}")`, maskImage: `url("${vibestMarkUrl}")` }}
      />
      {/* The product name as the desktop build spells it (electron-builder's
          `productName`), not the lowercase package id. */}
      <span className="text-sm font-medium tracking-tight">Vibest</span>
    </div>
  );
}
