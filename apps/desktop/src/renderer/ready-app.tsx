import { AppInterface, type ServerConnection, type ServerStatusFeed } from "@vibest/app";
import { use, useEffect, useState, type ReactElement } from "react";

import { startupAnimation } from "./startup-animation";

function sameConnection(a: ServerConnection, b: ServerConnection): boolean {
  return a.httpBaseUrl === b.httpBaseUrl && a.wsBaseUrl === b.wsBaseUrl && a.token === b.token;
}

export function ReadyApp({
  server,
  refresh,
  status,
  onReady,
}: {
  server: Promise<ServerConnection>;
  refresh: () => Promise<ServerConnection>;
  status: ServerStatusFeed;
  onReady: () => void;
}): ReactElement {
  const initial = use(server);
  const [connection, setConnection] = useState(initial);

  // The daemon mints a fresh token on every respawn, so the startup connection
  // dies with the first server restart. The feed only emits transitions, so
  // every "ready" it delivers means a restart just completed — re-fetch then,
  // keeping the old object identity when nothing actually changed.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = status.subscribe((next) => {
      if (next !== "ready") return;
      void refresh()
        .then((fresh) => {
          if (cancelled) return;
          setConnection((current) => (sameConnection(current, fresh) ? current : fresh));
        })
        .catch((error: unknown) => {
          console.error("Failed to refresh the server connection", error);
        });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [status, refresh]);

  use(startupAnimation);
  useEffect(onReady, [onReady]);
  return <AppInterface server={connection} />;
}
