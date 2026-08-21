import { ContentPanel } from "@/components/layout/content-panel/model/content-panel";
import type { AnyPanelView } from "@/components/layout/content-panel/react/view";

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The global host. Created here rather than at the composition root so
 * non-React callers — a command-palette entry, a keyboard map, a link handler
 * inside a renderer — can reach the same object the hooks wrap.
 */
export const contentPanel = new ContentPanel<AnyPanelView>({ storage: safeLocalStorage() });
