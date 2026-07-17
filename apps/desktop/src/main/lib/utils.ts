import path from "node:path";

import { app } from "electron";

/** Path under the OS temp dir, prefixed `vibest-desktop-`, for throwaway data. */
export function vibestTempPath(name: string): string {
  return path.join(app.getPath("temp"), `vibest-desktop-${name}`);
}
