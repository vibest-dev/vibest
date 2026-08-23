import { Button } from "@vibest/ui/components/button";
import { cn } from "@vibest/ui/lib/utils";
import { PanelRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useContentPanel, usePanelSnapshot } from "./hooks";

/**
 * Show/hide, for a header or a toolbar. Lives here rather than at its one call
 * site because "open the content panel" is a thing many places will want, and
 * each of them would otherwise re-derive the same two hooks.
 *
 * Renders nothing off a session — there is no panel to toggle.
 */
export type ContentPanelToggleProps = ComponentProps<typeof Button>;

export function ContentPanelToggle({ className, ...props }: ContentPanelToggleProps): ReactNode {
  const session = useContentPanel();
  const presentation = usePanelSnapshot((snapshot) => snapshot.presentation);
  if (session === null) return null;

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Toggle content panel"
      aria-pressed={presentation !== "hidden"}
      className={cn(presentation !== "hidden" && "bg-accent", className)}
      onClick={() => session.toggleVisibility()}
      {...props}
    >
      <PanelRightIcon className="size-3.5" />
    </Button>
  );
}
