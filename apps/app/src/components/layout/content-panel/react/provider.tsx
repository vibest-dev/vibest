import { type ReactNode, useMemo } from "react";

import type { ContentPanel } from "../core/content-panel";
import { ContentPanelContext } from "./context";
import type { AnyPanelView } from "./view";

/**
 * Carries the global host plus the identity everything below binds to. The
 * host itself is created outside React and outlives every route; only the
 * `sessionId` binding is React's business.
 *
 * `sessionId` and nothing else, deliberately: an ambient channel for values
 * particular panels want (a cwd, a git ref) would widen every consumer's memo
 * for the benefit of one. A panel that needs a workspace path takes it in its
 * payload — already persisted and parsed — or resolves it in its own view.
 */
export function ContentPanelProvider(props: {
  readonly contentPanel: ContentPanel<AnyPanelView>;
  readonly sessionId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const { contentPanel, sessionId, children } = props;
  const value = useMemo(() => ({ contentPanel, sessionId }), [contentPanel, sessionId]);
  return <ContentPanelContext value={value}>{children}</ContentPanelContext>;
}
