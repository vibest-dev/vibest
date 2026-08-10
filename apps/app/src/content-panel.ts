import { ContentPanel } from "@/components/layout/content-panel/core/content-panel";
import { browserPanel } from "@/components/layout/content-panel/panels/browser-panel";
import { diffPanel } from "@/components/layout/content-panel/panels/diff-panel";
import { filePanel } from "@/components/layout/content-panel/panels/file-panel";
import { terminalPanel } from "@/components/layout/content-panel/panels/terminal-panel";
import type { AnyPanelView } from "@/components/layout/content-panel/react/view";

/**
 * The global host. Created here rather than at the composition root so
 * non-React callers — a command-palette entry, a keyboard map, a link handler
 * inside a renderer — can reach the same object the hooks wrap.
 */
export const contentPanel = new ContentPanel<AnyPanelView>({ storage: window.localStorage });

// These definitions are unconditional application configuration, so register
// them with the app-lifetime host rather than making a route finish bootstrap.
// A future conditional panel should register with lifecycle at the boundary
// that owns its availability condition.
contentPanel.registerAll([terminalPanel, filePanel, diffPanel, browserPanel]);
