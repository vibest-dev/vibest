export const STARTUP_ANIMATION_MS = 1_000;

export function waitForStartupAnimation(reducedMotion: boolean): Promise<void> {
  if (reducedMotion) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, STARTUP_ANIMATION_MS));
}
