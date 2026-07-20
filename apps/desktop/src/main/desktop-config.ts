import path from "node:path";
import { fileURLToPath } from "node:url";

import { Context, Layer } from "effect";

export class DesktopConfig extends Context.Service<
  DesktopConfig,
  {
    readonly isPackaged: boolean;
    readonly devUrl: string | undefined;
    readonly serverEntry: string;
  }
>()("desktop/DesktopConfig") {}

export type DesktopConfigInputs = {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly devUrl: string | undefined;
};

export function resolveServerEntry(isPackaged: boolean, resourcesPath: string): string {
  if (isPackaged) {
    return path.join(
      resourcesPath,
      "app.asar",
      "node_modules",
      "@vibest",
      "server",
      "dist",
      "server.mjs",
    );
  }
  return fileURLToPath(new URL("../../../../packages/server/dist/server.mjs", import.meta.url));
}

export function buildDesktopConfig(inputs: DesktopConfigInputs): DesktopConfig["Service"] {
  return {
    isPackaged: inputs.isPackaged,
    devUrl: inputs.devUrl,
    serverEntry: resolveServerEntry(inputs.isPackaged, inputs.resourcesPath),
  };
}

export function makeDesktopConfigLive(inputs: DesktopConfigInputs): Layer.Layer<DesktopConfig> {
  return Layer.succeed(DesktopConfig, buildDesktopConfig(inputs));
}
