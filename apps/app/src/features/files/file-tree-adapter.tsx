import { FileTree as PierreFileTree } from "@pierre/trees/react";
import type { WorkspaceTreeEntry } from "@vibest/contract/fs";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import {
  getSessionFileTree,
  isOpenableTreeEntry,
  symlinkDescription,
  syncSessionFileTree,
} from "./session-file-tree";

const TREE_STYLE = {
  height: "100%",
  width: "100%",
  "--trees-bg-override": "var(--background)",
  "--trees-bg-muted-override": "var(--muted)",
  "--trees-border-color-override": "var(--border)",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-mono)",
  "--trees-font-size-override": "12px",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
} as CSSProperties;

function pathFromComposedEvent(event: MouseEvent<HTMLElement>): string | null {
  for (const target of event.nativeEvent.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.itemPath !== undefined) {
      return target.dataset.itemPath;
    }
  }
  return null;
}

export function FileTreeAdapter({
  sessionId,
  entries,
  onOpenFile,
}: {
  sessionId: string;
  entries: ReadonlyArray<WorkspaceTreeEntry>;
  onOpenFile: (path: string) => void;
}) {
  const state = useMemo(() => getSessionFileTree(sessionId), [sessionId]);
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    syncSessionFileTree(state, entries);
  }, [entries, state]);

  useEffect(() => {
    const host = containerRef.current?.querySelector("file-tree-container");
    const shadowRoot = host?.shadowRoot;
    if (shadowRoot === undefined || shadowRoot === null) return;

    const annotateRows = (): void => {
      for (const row of shadowRoot.querySelectorAll<HTMLElement>("[data-item-path]")) {
        const path = row.dataset.itemPath;
        const entry = path === undefined ? undefined : state.entryByPath.get(path);
        const description = entry === undefined ? null : symlinkDescription(entry);
        if (description === null) {
          row.removeAttribute("aria-description");
          row.removeAttribute("aria-disabled");
          continue;
        }
        row.setAttribute("aria-description", description);
        if (isOpenableTreeEntry(entry)) row.removeAttribute("aria-disabled");
        else row.setAttribute("aria-disabled", "true");
      }
    };

    annotateRows();
    const observer = new MutationObserver(annotateRows);
    observer.observe(shadowRoot, {
      attributeFilter: ["data-item-path"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [entries, state]);

  const openPath = (path: string | null): void => {
    if (path === null) return;
    const entry = state.entryByPath.get(path);
    if (isOpenableTreeEntry(entry)) onOpenFile(path);
  };

  const handleClick = (event: MouseEvent<HTMLElement>): void => {
    openPath(pathFromComposedEvent(event));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" || event.defaultPrevented) return;
    const focusedPath = state.model.getFocusedPath();
    if (
      !isOpenableTreeEntry(focusedPath === null ? undefined : state.entryByPath.get(focusedPath))
    ) {
      return;
    }
    event.preventDefault();
    onOpenFile(focusedPath!);
  };

  return (
    <div ref={containerRef} className="h-full min-h-0 w-full">
      <PierreFileTree
        aria-label="Project files"
        model={state.model}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        style={TREE_STYLE}
      />
    </div>
  );
}
