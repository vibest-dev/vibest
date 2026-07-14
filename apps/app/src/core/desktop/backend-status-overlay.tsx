import { Button } from "@vibest/ui/components/button";
import { Spinner } from "@vibest/ui/components/spinner";
import { type ReactElement, useEffect, useState } from "react";

import type { BackendStatus, BackendStatusFeed } from "../../platform";

/**
 * Desktop-only chrome that covers the UI while the shell restarts a crashed
 * backend. The renderer's oRPC clients reconnect on their own once the server
 * is back on its pinned port, so the app stays mounted underneath — this just
 * stops the user typing into a backend that isn't listening. A terminal
 * "failed" state (the shell gave up) offers Retry and Quit.
 */
export function BackendStatusOverlay({ feed }: { feed: BackendStatusFeed }): ReactElement | null {
  const [status, setStatus] = useState<BackendStatus>(feed.initial);

  // `subscribe` returns its own unsubscribe, so this doubles as the cleanup.
  useEffect(() => feed.subscribe(setStatus), [feed]);

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
              Vibest couldn&rsquo;t keep its backend running. Retry, or quit and reopen the app.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={feed.quit}>
              Quit
            </Button>
            <Button onClick={feed.retry}>Retry</Button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
