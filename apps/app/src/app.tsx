import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, type ReactElement } from "react";

import { ChatManagerProvider } from "./core/chat/chat-context";
import { ChatManager } from "./core/chat/chat-manager";
import { ChatTransport } from "./core/chat/chat-transport";
import { BackendStatusOverlay } from "./core/desktop/backend-status-overlay";
import { createAppClients } from "./lib/orpc";
import type { Platform } from "./platform";
import { createRouter } from "./router";

// Dev only: hover any element and press Cmd/Ctrl+C to copy it with its React
// component stack and source locations, for pasting into a coding agent. The
// guard is statically false in production, so react-grab is dead-code-eliminated
// from both the Vite and electron-vite builds. See https://react-grab.com.
if (import.meta.env.DEV) {
  void import("react-grab");
}

/**
 * The whole UI, parameterised by its host. Both entry points — the browser's
 * `main.tsx` and the Electron renderer's — call this with the Platform they
 * constructed, and render the result.
 */
export function createApp(platform: Platform): ReactElement {
  const clients = createAppClients(platform);
  const router = createRouter(clients);
  const chatManager = new ChatManager(new ChatTransport(clients));

  return (
    <StrictMode>
      <QueryClientProvider client={clients.queryClient}>
        <ChatManagerProvider manager={chatManager}>
          <RouterProvider router={router} />
          {platform.host === "desktop" && <BackendStatusOverlay feed={platform.status} />}
        </ChatManagerProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
