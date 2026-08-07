import { ContentPanel } from "@/components/layout/content-panel/core/content-panel";
import type { AnyPanelDefinition } from "@/components/layout/content-panel/core/panel";
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

/**
 * Registered unconditionally at mount. Definitions are a few bytes of data, so
 * they register eagerly even when their content is code-split — a panel that
 * registers late has its tab pop in, and worse, an active panel restored from
 * storage leaves the container blank until it arrives. Conditional
 * registration is for panels that genuinely may not exist (harness-specific,
 * git-only), not for deferring load.
 */
export const STATIC_PANELS: readonly AnyPanelDefinition<AnyPanelView>[] = [
  terminalPanel,
  filePanel,
  diffPanel,
  browserPanel,
];
