export const STARTUP_ANIMATION_MS = 650;

export function waitForStartupAnimation(reducedMotion: boolean): Promise<void> {
  if (reducedMotion) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, STARTUP_ANIMATION_MS));
}
