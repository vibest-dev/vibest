import { AppInterface, type ServerConnection } from "@vibest/app";
import { use, useEffect, type ReactElement } from "react";

import { startupAnimation } from "./startup-animation";

export function ReadyApp({
  server,
  onReady,
}: {
  server: Promise<ServerConnection>;
  onReady: () => void;
}): ReactElement {
  const connection = use(server);
  use(startupAnimation);
  useEffect(onReady, [onReady]);
  return <AppInterface server={connection} />;
}
