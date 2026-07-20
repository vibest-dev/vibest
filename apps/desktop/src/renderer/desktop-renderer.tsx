import { PlatformProvider, ServerStatusOverlay } from "@vibest/app";
import { Suspense, use, type ReactElement } from "react";

import type { DesktopHost } from "./desktop-host";
import { ReadyApp } from "./ready-app";

export function DesktopRenderer({
  host,
  onReady,
}: {
  host: Promise<DesktopHost>;
  onReady: () => void;
}): ReactElement {
  const desktop = use(host);
  return (
    <PlatformProvider value={desktop.platform}>
      <ServerStatusOverlay feed={desktop.status} />
      <Suspense fallback={null}>
        <ReadyApp
          server={desktop.server}
          refresh={desktop.refreshServer}
          status={desktop.status}
          onReady={onReady}
        />
      </Suspense>
    </PlatformProvider>
  );
}
