import { consumeEventIterator } from "@orpc/client";
import type { Platform } from "@vibest/app/platform";

import type { DesktopBootstrap } from "../shared/desktop-rpc";
import type { DesktopClient } from "./desktop-client";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createDesktopPlatform(
  client: DesktopClient,
  bootstrap: DesktopBootstrap,
): Extract<Platform, { host: "desktop" }> {
  return {
    host: "desktop",
    os: bootstrap.os,
    backend: bootstrap.backend,
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
        void client.backend.retry().catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Failed to retry desktop backend", error);
        });
      },
      quit: () => {
        void client.app.quit().catch((error: unknown) => {
          if (!isAbortError(error)) console.error("Failed to request desktop quit", error);
        });
      },
    },
  };
}
