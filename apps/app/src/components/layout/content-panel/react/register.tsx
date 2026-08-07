import { useLayoutEffect } from "react";

import type { AnyPanelDefinition } from "../core/panel";
import { useContentPanelContext } from "./context";
import type { AnyPanelView } from "./view";

/**
 * Registers a batch and retracts it on unmount, which is what makes conditional
 * registration just conditional rendering. One layout effect for the whole
 * list, not one per definition: each registration invalidates every derived tab
 * list, so a per-definition effect would discard it N times before first paint.
 *
 * Layout effect rather than effect: the open panels come back from storage on
 * the first render, so registering after paint would show an empty tab strip
 * for a frame.
 */
export interface RegisterPanelsProps {
  readonly definitions: readonly AnyPanelDefinition<AnyPanelView>[];
}

export function RegisterPanels({ definitions }: RegisterPanelsProps): null {
  const { contentPanel } = useContentPanelContext();
  useLayoutEffect(() => contentPanel.registerAll(definitions), [contentPanel, definitions]);
  return null;
}
