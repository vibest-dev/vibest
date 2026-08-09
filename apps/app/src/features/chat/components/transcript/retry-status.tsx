import type { TurnRetryState } from "@vibest/contract";
import { useSyncExternalStore } from "react";

import { systemClock } from "../../runtime/system-clock";
import { retryStatusText } from "./retry-countdown";

export function RetryStatus({ retry }: { retry: TurnRetryState }) {
  const now = useSyncExternalStore(
    systemClock.subscribe,
    systemClock.getSnapshot,
    systemClock.getSnapshot,
  );
  return <div className="text-muted-foreground text-xs">{retryStatusText(retry, now)}</div>;
}
