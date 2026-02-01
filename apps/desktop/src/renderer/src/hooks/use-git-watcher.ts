import { consumeEventIterator } from "@orpc/client";
import { useEffect, useRef } from "react";

import { client } from "../lib/client";
import { orpc } from "../lib/orpc";
import { queryClient } from "../lib/query-client";

/**
 * Hook to subscribe to git changes for a worktree path.
 * Automatically invalidates git.diff and git.status queries when changes are detected.
 *
 * @param path - The worktree path to watch, or undefined to disable watching
 */
export function useGitWatcher(path: string | undefined): void {
  const cancelRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!path) return;

    // Track if this effect instance is still active (for StrictMode)
    let isActive = true;

    // Subscribe to git changes for this path
    const cancel = consumeEventIterator(client.git.watchChanges({ path }), {
      onEvent: (event) => {
        if (!isActive) return;

        // Invalidate queries when git changes are detected
        if (event.type === "diff") {
          queryClient.invalidateQueries({
            queryKey: orpc.git.diff.key({ input: { path, staged: false } }),
          });
          queryClient.invalidateQueries({
            queryKey: orpc.git.status.key({ input: { path } }),
          });
        }
      },
      onError: (error) => {
        // Ignore AbortError - expected when component unmounts
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        console.error("[GitWatcher] Subscription error:", error);
      },
    });
    cancelRef.current = cancel;

    // Cleanup
    return () => {
      isActive = false;
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [path]);
}
