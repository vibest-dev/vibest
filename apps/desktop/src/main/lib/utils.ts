import path from "node:path";

import { app } from "electron";

/**
 * Build a path under the OS temp directory, namespaced with a `vibest-desktop-`
 * prefix. For throwaway data that must stay out of the app's real userData and
 * is fine to be cleaned up by the OS — e.g. an isolated userData dir for CDP
 * debugging.
 */
export function vibestTempPath(name: string): string {
  return path.join(app.getPath("temp"), `vibest-desktop-${name}`);
}
