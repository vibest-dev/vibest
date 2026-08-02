import { Button } from "@vibest/ui/components/button";
import { Spinner } from "@vibest/ui/components/spinner";
import { type ReactElement, useSyncExternalStore } from "react";

import { usePlatform } from "../../platform-context";
import type { ServerStatusFeed } from "../../server-status";

/**
 * Covers the UI while the host restarts a crashed server. The oRPC client
 * reconnects on its own once the server is back, so the app stays mounted
 * underneath. A terminal "failed" state offers Retry and Quit.
 */
export function ServerStatusOverlay({ feed }: { feed: ServerStatusFeed }): ReactElement | null {
  const platform = usePlatform();
  // The host owns this status; React only reads it. `feed` is a host singleton,
  // so both methods are referentially stable.
  const status = useSyncExternalStore(feed.subscribe, feed.getSnapshot);

  // Initial startup is owned by the host's branded sequence. This overlay
  // only handles reconnecting or terminal failure.
  if (status === "starting") return null;

  if (status === "reconnecting") {
    return (
      <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
        <div className="flex flex-col items-center gap-3 text-center">
          <Spinner className="text-muted-foreground size-6" />
          <div>
            <p className="text-foreground text-sm font-medium">Reconnecting…</p>
            <p className="text-muted-foreground text-sm">
              The local server restarted. Reconnecting to it now.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="bg-background/90 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <div>
            <p className="text-foreground text-base font-medium">The local server stopped</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Vibest couldn&rsquo;t keep its server running. Retry, or quit and reopen the app.
            </p>
          </div>
          <div className="flex gap-2">
            {platform.quit && (
              <Button variant="outline" onClick={platform.quit}>
                Quit
              </Button>
            )}
            <Button onClick={feed.retry}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
