import { Suspense, useCallback, useState, type ReactElement } from "react";

import type { DesktopHost } from "./desktop-host";
import { DesktopRenderer } from "./desktop-renderer";
import { StartupScreen } from "./startup-screen";

export function DesktopRoot({ host }: { host: Promise<DesktopHost> }): ReactElement {
  const [ready, setReady] = useState(false);
  const onReady = useCallback(() => setReady(true), []);

  return (
    <>
      {ready ? null : <StartupScreen />}
      <Suspense fallback={null}>
        <DesktopRenderer host={host} onReady={onReady} />
      </Suspense>
    </>
  );
}
