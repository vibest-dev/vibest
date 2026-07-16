import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "react-error-boundary";

import { createDesktopClient } from "./desktop-client";
import { createDesktopHost } from "./desktop-host";
import { waitForDesktopPort } from "./desktop-port";
import { DesktopRoot } from "./desktop-root";
import { StartupFailure } from "./startup-failure";

const rootElement = document.getElementById("root")!;
if (!rootElement) throw new Error("Root element not found");

const host = waitForDesktopPort().then(async (port) => {
  const client = createDesktopClient(port);
  const bootstrap = await client.bootstrap();
  return createDesktopHost(client, bootstrap, client.server.connection());
});

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary FallbackComponent={StartupFailure}>
      <DesktopRoot host={host} />
    </ErrorBoundary>
  </StrictMode>,
);
