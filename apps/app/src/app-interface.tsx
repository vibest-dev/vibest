import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { Toaster } from "sonner";

import "./index.css";

import { ChatManagerProvider } from "./core/chat/chat-context";
import { ChatManager } from "./core/chat/chat-manager";
import { OrpcChatSessionTransport } from "./core/chat/chat-transport";
import { SessionEventsSync } from "./core/session/session-events-sync";
import { createAppClients, type AppClients } from "./lib/orpc";
import { usePlatform } from "./platform-context";
import { createRouter } from "./router";
import type { ServerConnection } from "./server-connection";

// react-grab and react-scan, and the telemetry they need muzzled to stay inside
// the Electron renderer's CSP. Statically false in production, so `dev-tools`
// and both packages drop out of the Vite and electron-vite builds.
if (import.meta.env.DEV) {
  void import("./dev-tools").then(({ startDevTools }) => startDevTools());
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
