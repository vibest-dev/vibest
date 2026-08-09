import type { TurnRetryState } from "@vibest/contract";
import { useSyncExternalStore } from "react";

import { retryStatusText } from "./retry-countdown";

const listeners = new Set<() => void>();
let currentTime = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

const updateClock = () => {
  currentTime = Date.now();
  for (const listener of listeners) listener();
};

const subscribeClock = (listener: () => void) => {
  listeners.add(listener);
  updateClock();
  timer ??= setInterval(updateClock, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const getClockSnapshot = () => currentTime;

export function RetryStatus({ retry }: { retry: TurnRetryState }) {
  const now = useSyncExternalStore(subscribeClock, getClockSnapshot, getClockSnapshot);
  return <div className="text-muted-foreground text-xs">{retryStatusText(retry, now)}</div>;
}
