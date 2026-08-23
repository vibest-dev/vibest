import {
  File,
  Virtualizer,
  type FileOptions,
  type SelectedLineRange,
  useVirtualizer,
} from "@pierre/diffs/react";
import {
  type MutableRefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

const PREVIEW_UNSAFE_CSS = `
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

  [data-line][data-selected-line] {
    box-shadow: inset 3px 0 0 var(--diffs-selection-base);
  }
`;

const DEFAULT_LINE_HEIGHT = 20;

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

function TargetLineScroller({
  lastScrolledTarget,
  targetKey,
  targetLine,
}: {
  lastScrolledTarget: MutableRefObject<string | null>;
  targetKey: string | null;
  targetLine: number | undefined;
}) {
  const virtualizer = useVirtualizer();

  useLayoutEffect(() => {
    if (targetKey === null || targetLine === undefined) {
      lastScrolledTarget.current = null;
      return;
    }
    if (virtualizer === undefined || lastScrolledTarget.current === targetKey) return;

    let scrollFrame = 0;
    const renderFrame = requestAnimationFrame(() => {
      scrollFrame = requestAnimationFrame(() => {
        const root = virtualizer.getRoot();
        const viewportHeight =
          root instanceof HTMLElement ? root.clientHeight : globalThis.innerHeight;
        virtualizer.scrollTo({
          top: Math.max(0, (targetLine - 0.5) * DEFAULT_LINE_HEIGHT - viewportHeight / 2),
        });
      });
    });

    return () => {
      cancelAnimationFrame(renderFrame);
      cancelAnimationFrame(scrollFrame);
    };
  }, [lastScrolledTarget, targetKey, targetLine, virtualizer]);

  return null;
}

export function FilePreviewAdapter({
  path,
  content,
  navigationRequest,
  targetLine,
}: {
  path: string;
  content: string;
  navigationRequest: number;
  targetLine?: number;
}) {
  const lastScrolledTarget = useRef<string | null>(null);
  const themeType = useSyncExternalStore(
    subscribeToAppTheme,
    getAppThemeType,
    () => "light" as const,
  );
  const validTargetLine =
    targetLine !== undefined && Number.isInteger(targetLine) && targetLine > 0
      ? targetLine
      : undefined;
  const scrollTargetKey =
    validTargetLine === undefined
      ? null
      : `${path}:${validTargetLine}:${content.length}:${navigationRequest}`;

  const file = useMemo(() => ({ name: path, contents: content }), [content, path]);
  const selectedLines = useMemo<SelectedLineRange | null>(
    () => (validTargetLine === undefined ? null : { start: validTargetLine, end: validTargetLine }),
    [validTargetLine],
  );
  const options = useMemo<FileOptions<undefined>>(
    () => ({
      disableFileHeader: true,
      overflow: "scroll",
      theme: { dark: "pierre-dark", light: "pierre-light" },
      themeType,
      unsafeCSS: PREVIEW_UNSAFE_CSS,
      onPostRender(node, _instance, phase) {
        if (phase === "unmount") return;
        const shadowRoot = node.shadowRoot;
        if (shadowRoot === null) return;

        for (const previous of shadowRoot.querySelectorAll("[data-vibest-target-line]")) {
          previous.removeAttribute("aria-current");
          previous.removeAttribute("aria-label");
          previous.removeAttribute("data-vibest-target-line");
        }
        if (validTargetLine === undefined || scrollTargetKey === null) return;

        requestAnimationFrame(() => {
          const row = shadowRoot.querySelector(
            `[data-line][data-line-index="${validTargetLine - 1}"]`,
          );
          if (!(row instanceof HTMLElement)) return;
          row.dataset.vibestTargetLine = "true";
          row.setAttribute("aria-current", "location");
          row.setAttribute("aria-label", `Target line ${validTargetLine}`);
          if (lastScrolledTarget.current === scrollTargetKey) return;
          lastScrolledTarget.current = scrollTargetKey;
          row.scrollIntoView({ block: "center", inline: "nearest" });
        });
      },
    }),
    [scrollTargetKey, themeType, validTargetLine],
  );

  return (
    <div className="h-full w-full">
      {validTargetLine === undefined ? null : (
        <span aria-live="polite" className="sr-only" role="status">
          Target line {validTargetLine}
        </span>
      )}
      <Virtualizer
        className="h-full w-full overflow-auto"
        contentStyle={{ display: "flex", minHeight: "100%", width: "100%" }}
      >
        <TargetLineScroller
          lastScrolledTarget={lastScrolledTarget}
          targetKey={scrollTargetKey}
          targetLine={validTargetLine}
        />
        <File
          className="min-h-full min-w-full"
          file={file}
          options={options}
          selectedLines={selectedLines}
        />
      </Virtualizer>
    </div>
  );
}
