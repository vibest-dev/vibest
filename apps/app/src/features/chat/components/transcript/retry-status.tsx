import type { TurnRetryState } from "@vibest/contract";
import { useEffect, useState } from "react";

import { retryStatusText } from "./retry-countdown";

function useNow(): number {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return now;
}

export function RetryStatus({ retry }: { retry: TurnRetryState }) {
  const now = useNow();
  return <div className="text-muted-foreground text-xs">{retryStatusText(retry, now)}</div>;
}
