import { parseDiffFromFile } from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import type { GitFileDiff } from "@vibest/contract/git";
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

const DIFF_UNSAFE_CSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-light-bg: var(--background);
    --diffs-dark-bg: var(--background);
    --diffs-light: var(--foreground);
    --diffs-dark: var(--foreground);
    --diffs-fg-number-override: var(--muted-foreground);
    --diffs-bg-buffer-override: var(--background);
    --diffs-bg-context-override: var(--background);
    --diffs-bg-context-gutter-override: var(--background);
    --diffs-bg-separator-override: var(--border);
    min-height: 100%;
    width: 100%;
  }

  [data-diffs-header] {
    cursor: pointer;
  }
`;

const getAppThemeType = (): "dark" | "light" =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

const subscribeToAppTheme = (listener: () => void): (() => void) => {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, {
    attributeFilter: ["class"],
    attributes: true,
  });
  return () => observer.disconnect();
};

function parseReviewDiff(diff: GitFileDiff) {
  return parseDiffFromFile(
    diff.oldContents === null
      ? null
      : { name: diff.oldPath ?? diff.path, contents: diff.oldContents },
    diff.newContents === null ? null : { name: diff.path, contents: diff.newContents },
  );
}

function itemIdFromInstance(instance: object): string | undefined {
  if (!("fileDiff" in instance)) return undefined;
  const fileDiff = instance.fileDiff;
  if (fileDiff === null || typeof fileDiff !== "object" || !("name" in fileDiff)) return undefined;
  const name = fileDiff.name;
  return typeof name === "string" ? name : undefined;
}

export function ReviewDiffAdapter({
  diffs,
  locatePath,
  locateRequest,
}: {
  diffs: ReadonlyArray<GitFileDiff>;
  locatePath?: string;
  locateRequest: number;
}) {
  const themeType = useSyncExternalStore(
    subscribeToAppTheme,
    getAppThemeType,
    () => "light" as const,
  );
  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [appliedLocate, setAppliedLocate] = useState(locateRequest);
  if (locateRequest !== appliedLocate) {
    setAppliedLocate(locateRequest);
    if (locatePath !== undefined && collapsed.has(locatePath)) {
      const next = new Set(collapsed);
      next.delete(locatePath);
      setCollapsed(next);
    }
  }
  const fileDiffs = useMemo(
    () => diffs.map((diff) => ({ path: diff.path, fileDiff: parseReviewDiff(diff) })),
    [diffs],
  );

  const items = useMemo<ReadonlyArray<CodeViewItem>>(
    () =>
      fileDiffs.map(({ path, fileDiff }) => ({
        id: path,
        type: "diff",
        fileDiff,
        collapsed: collapsed.has(path),
      })),
    [collapsed, fileDiffs],
  );

  const options = useMemo<CodeViewReactOptions>(
    () => ({
      overflow: "scroll",
      stickyHeaders: true,
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType,
      unsafeCSS: DIFF_UNSAFE_CSS,
      onPostRender(node, instance, phase) {
        if (phase === "unmount") return;
        const header = node.shadowRoot?.querySelector("[data-diffs-header]");
        if (!(header instanceof HTMLElement)) return;
        const id = itemIdFromInstance(instance);
        if (id !== undefined) header.dataset.reviewPath = id;
        if (header.dataset.reviewCollapseBound === "true") return;
        header.dataset.reviewCollapseBound = "true";
        header.addEventListener("click", () => {
          const path = header.dataset.reviewPath;
          if (path === undefined) return;
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          });
        });
      },
    }),
    [themeType],
  );

  useLayoutEffect(() => {
    if (locatePath === undefined) return;
    if (!fileDiffs.some((entry) => entry.path === locatePath)) return;
    codeViewRef.current?.scrollTo({ type: "item", id: locatePath, align: "start" });
  }, [fileDiffs, locatePath, locateRequest]);

  return (
    <div className="h-full min-h-0 w-full">
      <CodeView className="h-full w-full" items={items} options={options} ref={codeViewRef} />
    </div>
  );
}
