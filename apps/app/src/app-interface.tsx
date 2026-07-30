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

// Dev only, dead-code-eliminated from both the Vite and electron-vite builds:
//   - react-grab (https://react-grab.com) — hover any element and press
//     Cmd/Ctrl+C to copy it with its React component stack and source
//     locations, for pasting into a coding agent.
//   - react-scan (https://react-scan.com) — highlights components as they
//     re-render so you can spot wasted renders. Loaded a tick later than its
//     ideal "before React" position, so it may miss the very first render.
//
// Both ship the same version check against react-grab.com, which the Electron
// renderer's CSP blocks — a console error each, on every startup. react-grab
// only skips it when `init` runs with `telemetry: false`, and importing the
// package auto-inits with the defaults, so `__REACT_GRAB_DISABLED__` (its
// documented escape hatch) suppresses that and we init by hand. react-scan
// skips its own copy of the check once `window.__REACT_GRAB__` is set, which is
// what `setGlobalApi` does — hence react-grab has to go first.
if (import.meta.env.DEV) {
  void (async () => {
    // oxlint-disable-next-line no-underscore-dangle -- react-grab's own flag name
    window.__REACT_GRAB_DISABLED__ = true;
    const { init, setGlobalApi } = await import("react-grab");
    // oxlint-disable-next-line no-underscore-dangle -- react-grab's own flag name
    delete window.__REACT_GRAB_DISABLED__;
    const api = init({ telemetry: false });
    setGlobalApi(api);
    // What the auto-init path announces; devtools integrations watch for it.
    window.dispatchEvent(new CustomEvent("react-grab:init", { detail: api }));
    const { scan } = await import("react-scan");
    scan();
  })();
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
