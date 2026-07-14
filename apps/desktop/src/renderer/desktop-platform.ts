import type { Platform } from "@vibest/app/platform";

import type { DesktopBootstrap } from "../shared/desktop-rpc";
import type { DesktopClient } from "./desktop-client";

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

        void (async () => {
          let revision = bootstrap.statusRevision;
          let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

          while (!controller.signal.aborted) {
            try {
              const next = await client.status.watch(
                { after: revision },
                { signal: controller.signal },
              );
              if (next.revision > revision) {
                revision = next.revision;
                listener(next.status);
              }
              reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
              continue;
            } catch (error) {
              if (controller.signal.aborted || isAbortError(error)) return;
              console.error("Desktop status poll failed", error);
            }

            await delay(reconnectDelay, controller.signal);
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          }
        })();

        return () => controller.abort();
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
