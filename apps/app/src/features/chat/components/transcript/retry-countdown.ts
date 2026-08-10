import type { TurnRetryState } from "@vibest/contract";

export function retryCountdownSeconds(retryAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil((retryAt - nowMs) / 1000));
}

export function retryStatusText(retry: TurnRetryState, nowMs: number): string {
  const seconds = retryCountdownSeconds(retry.retryAt, nowMs);
  const count = `${retry.attempt}/${retry.maxAttempts}`;
  return seconds > 0 ? `Retrying ${count} in ${seconds}s…` : `Retrying ${count}…`;
}
