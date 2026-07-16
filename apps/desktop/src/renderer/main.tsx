import {
  AppInterface,
  ServerStatusOverlay,
  PlatformProvider,
  type ServerConnection,
} from "@vibest/app";
import { StrictMode, Suspense, use, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "react-error-boundary";

import { createDesktopClient } from "./desktop-client";
import { createDesktopHost } from "./desktop-host";
import { waitForDesktopPort } from "./desktop-port";
import { StartupFailure } from "./startup-failure";
import { StartupScreen } from "./startup-screen";

const rootElement = document.getElementById("root")!;
if (!rootElement) throw new Error("Root element not found");

const host = waitForDesktopPort().then(async (port) => {
  const client = createDesktopClient(port);
  const bootstrap = await client.bootstrap();
  return createDesktopHost(client, bootstrap, client.server.connection());
});

function ReadyApp({ server }: { server: Promise<ServerConnection> }): ReactElement {
  return <AppInterface server={use(server)} />;
}

function DesktopRenderer(): ReactElement {
  const desktop = use(host);
  return (
    <PlatformProvider value={desktop.platform}>
      <ServerStatusOverlay feed={desktop.status} />
      <Suspense fallback={<StartupScreen />}>
        <ReadyApp server={desktop.server} />
      </Suspense>
    </PlatformProvider>
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary FallbackComponent={StartupFailure}>
      <Suspense fallback={<StartupScreen />}>
        <DesktopRenderer />
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
);
