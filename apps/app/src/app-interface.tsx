import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";

import "./index.css";

import { ChatManagerProvider } from "./core/chat/chat-context";
import { ChatManager } from "./core/chat/chat-manager";
import { OrpcChatSessionTransport } from "./core/chat/chat-transport";
import { createAppClients, type AppClients } from "./lib/orpc";
import { usePlatform } from "./platform-context";
import { createRouter } from "./router";
import type { ServerConnection } from "./server-connection";

// Dev only: hover any element and press Cmd/Ctrl+C to copy it with its React
// component stack and source locations, for pasting into a coding agent. The
// guard is statically false in production, so react-grab is dead-code-eliminated
// from both the Vite and electron-vite builds. See https://react-grab.com.
if (import.meta.env.DEV) {
  void import("react-grab");
}

// Dev only: highlights components as they re-render so you can spot wasted
// renders. Loaded just after React (a tick later than react-scan's ideal
// "before React" position), so it may miss the very first render but catches
// everything after. Dead-code-eliminated from production. See https://react-scan.com.
if (import.meta.env.DEV) {
  void import("react-scan").then(({ scan }) => scan());
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
        <RouterProvider router={router} />
      </ChatManagerProvider>
    </QueryClientProvider>
  );
}
