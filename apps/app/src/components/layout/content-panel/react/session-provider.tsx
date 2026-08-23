import type { SessionRef } from "@vibest/contract";
import { type ReactNode, useMemo } from "react";

import type { ContentPanel } from "../model/content-panel";
import { ContentPanelContext } from "./context";
import type { AnyPanelView } from "./view";

/**
 * Carries the global host plus the identity everything below binds to. The
 * host itself is created outside React and outlives every route; only the
 * authoritative `SessionRef` binding is React's business.
 *
 * The ref is identity, not an ambient data bag: panel-specific values such as a
 * workspace path or git ref still belong in that panel's own payload/model.
 */
export interface ContentPanelSessionProviderProps {
  readonly contentPanel: ContentPanel<AnyPanelView>;
  /** null off a session route; every panel hook below degrades to a no-op. */
  readonly sessionRef: SessionRef | null;
  readonly children: ReactNode;
}

export function ContentPanelSessionProvider(props: ContentPanelSessionProviderProps): ReactNode {
  const { contentPanel, sessionRef, children } = props;
  const value = useMemo(() => ({ contentPanel, sessionRef }), [contentPanel, sessionRef]);
  return <ContentPanelContext value={value}>{children}</ContentPanelContext>;
}
