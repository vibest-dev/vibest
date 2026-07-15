import { describe, expect, it } from "vitest";

import { buildDesktopConfig } from "./desktop-config";
import { APP_ORIGIN } from "./electron/app-protocol";

describe("buildDesktopConfig", () => {
  it("resolves the packaged server entry under resourcesPath", () => {
    const config = buildDesktopConfig({
      isPackaged: true,
      resourcesPath: "/Applications/Vibest.app/Contents/Resources",
      devUrl: undefined,
      token: "fixed-token",
    });

    expect(config.serverEntry).toBe(
      "/Applications/Vibest.app/Contents/Resources/app.asar/node_modules/@vibest/cli/dist/cli.mjs",
    );
    expect(config.allowedOrigins).toEqual([APP_ORIGIN]);
    expect(config.token).toBe("fixed-token");
  });

  it("resolves the dev server entry relative to the package output", () => {
    const config = buildDesktopConfig({
      isPackaged: false,
      resourcesPath: "/unused",
      devUrl: undefined,
      token: "fixed-token",
    });

    expect(config.serverEntry).toMatch(/packages\/vibest\/dist\/cli\.mjs$/);
  });

  it("includes the dev renderer origin when a devUrl is set", () => {
    const config = buildDesktopConfig({
      isPackaged: false,
      resourcesPath: "/unused",
      devUrl: "http://localhost:5173",
      token: "fixed-token",
    });

    expect(config.allowedOrigins).toEqual([APP_ORIGIN, "http://localhost:5173"]);
  });
});
