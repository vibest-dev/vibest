import { AppInterface, type ServerConnection } from "@vibest/app";
import { use, useEffect, type ReactElement } from "react";

export function ReadyApp({
  server,
  startupAnimation,
  onReady,
}: {
  server: Promise<ServerConnection>;
  startupAnimation: Promise<void>;
  onReady: () => void;
}): ReactElement {
  const connection = use(server);
  use(startupAnimation);
  useEffect(onReady, [onReady]);
  return <AppInterface server={connection} />;
}
