export const STARTUP_ANIMATION_MS = 1_000;

export function waitForStartupAnimation(reducedMotion: boolean): Promise<void> {
  if (reducedMotion) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, STARTUP_ANIMATION_MS));
}

export const startupAnimation =
  typeof globalThis.matchMedia === "function"
    ? waitForStartupAnimation(globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches)
    : Promise.resolve();
