import type { TurnRetryState } from "@vibest/contract";

export function retryCountdownSeconds(nextAttemptAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((nextAttemptAt - nowMs) / 1000));
}

export function retryStatusText(retry: TurnRetryState, nowMs: number): string {
  const seconds = retryCountdownSeconds(retry.nextAttemptAt, nowMs);
  const count = `${retry.retryNumber}/${retry.maxRetries}`;
  return seconds > 0 ? `Retrying ${count} in ${seconds}s…` : `Retrying ${count}…`;
}
