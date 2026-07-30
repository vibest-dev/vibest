import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import type { ReactGrabAPI } from "react-grab/core";
import { Toaster } from "sonner";

import "./index.css";

import { ChatManager } from "./core/chat/chat-manager";
import { ChatManagerProvider } from "./core/chat/chat-manager-provider";
import { OrpcChatSessionTransport } from "./core/chat/chat-transport";
import { SessionEventsSync } from "./core/session/session-events-sync";
import { createAppClients, type AppClients } from "./lib/orpc";
import { usePlatform } from "./platform-context";
import { createRouter } from "./router";
import type { ServerConnection } from "./server-connection";

declare global {
  interface Window {
    /** react-grab's `init` result; its package root publishes this on auto-init. */
    __REACT_GRAB__?: ReactGrabAPI;
  }
}

// Dev only, dead-code-eliminated from both the Vite and electron-vite builds:
// react-grab (hover an element, Cmd/Ctrl+C, paste it into a coding agent) and
// react-scan (highlights re-renders). See react-grab.com and react-scan.com.
//
// Both would otherwise fetch react-grab.com/api/version at startup, which the
// Electron renderer's CSP blocks with a console error. `react-grab/core` is the
// entry that doesn't auto-init, so it takes `telemetry: false`; react-scan has
// no such option but skips its own copy of the check when `window.__REACT_GRAB__`
// is set — so publishing it here is what keeps react-scan quiet, and it has to
// happen before react-scan loads.
if (import.meta.env.DEV) {
  void import("react-grab/core").then(async ({ init }) => {
    // oxlint-disable-next-line no-underscore-dangle -- react-grab's own global name
    window.__REACT_GRAB__ = init({ telemetry: false });
    const { scan } = await import("react-scan");
    scan();
  });
}

/** Shared application entry. PlatformProvider is the host seam above it. */
export function AppInterface({ server }: { server?: ServerConnection }): ReactElement {
  usePlatform();
  const [clients] = useState(() => createAppClients(server));
  return <AppRuntime {...clients} />;
}

/** Explicit stable application dependencies, with no host knowledge. */
function AppRuntime({ orpcClient, queryClient, orpcQueryUtils }: AppClients): ReactElement {
  const [router] = useState(() => createRouter({ queryClient, orpcQueryUtils }));
  // Composition root: the only place that knows Chat's wire transport is oRPC.
  const [chatManager] = useState(
    () => new ChatManager((ref) => new OrpcChatSessionTransport(orpcClient, ref)),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ChatManagerProvider manager={chatManager}>
        {/*
         * Keeps every `session.list` cache converged from the server's collection
         * events (multi-tab / desktop), independent of which surface is mounted.
         */}
        <SessionEventsSync
          client={orpcClient}
          orpcQueryUtils={orpcQueryUtils}
          queryClient={queryClient}
        />
        <RouterProvider router={router} />
        {/*
         * The app's only error surface. Every `toast.*` call — the QueryClient's
         * global query-error handler in lib/orpc.ts, failed imports, failed
         * session creates, failed resumes — renders nothing without this mount.
         */}
        <Toaster theme="system" />
      </ChatManagerProvider>
    </QueryClientProvider>
  );
}
