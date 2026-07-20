import { consumeEventIterator } from "@orpc/client";
import type { ServerStatusFeed, Platform } from "@vibest/app";

import type { ServerConnection, DesktopBootstrap } from "../shared/desktop-rpc";
import type { DesktopClient } from "./desktop-client";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export type DesktopHost = {
  platform: Platform;
  server: Promise<ServerConnection>;
  /**
   * Re-fetch the current connection. The daemon mints a fresh token (and can
   * land on a new port) every time it respawns, so the startup connection goes
   * stale on every server restart — consumers re-fetch when the status feed
   * reports ready again.
   */
  refreshServer: () => Promise<ServerConnection>;
  status: ServerStatusFeed;
};

export function createDesktopHost(
  client: DesktopClient,
  bootstrap: DesktopBootstrap,
  server: Promise<ServerConnection>,
): DesktopHost {
  // AppInterface reads this promise only after the desktop shell is mounted.
  // Keep a rejection handler attached before that first read.
  void server.catch((error: unknown) => {
    if (!isAbortError(error)) console.error("Desktop server connection failed", error);
  });

  return {
    platform: {
      quit: () => {
        void client.app.quit().catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Failed to request desktop quit", error);
        });
      },
    },
    server,
    refreshServer: () => client.server.connection(),
    status: {
      initial: bootstrap.status,
      subscribe: (listener) => {
        const controller = new AbortController();
        let revision = bootstrap.statusRevision;
        const unsubscribe = consumeEventIterator(
          client.status.subscribe({ after: revision }, { signal: controller.signal }),
          {
            onEvent: (snapshot) => {
              if (snapshot.revision <= revision) return;
              revision = snapshot.revision;
              listener(snapshot.status);
            },
            onError: (error) => {
              if (!controller.signal.aborted && !isAbortError(error)) {
                console.error("Desktop status stream failed", error);
              }
            },
            onFinish: () => {},
          },
        );

        return () => {
          controller.abort();
          void unsubscribe().catch((error: unknown) => {
            if (!isAbortError(error)) {
              console.error("Failed to unsubscribe from desktop status", error);
            }
          });
        };
      },
      retry: () => {
        void client.server.retry().catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Failed to retry desktop server", error);
        });
      },
    },
  };
}
