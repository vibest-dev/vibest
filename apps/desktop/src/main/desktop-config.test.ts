import { describe, expect, it } from "vitest";

import { buildDesktopConfig } from "./desktop-config";

describe("buildDesktopConfig", () => {
  it("resolves the packaged server entry under resourcesPath", () => {
    const config = buildDesktopConfig({
      isPackaged: true,
      resourcesPath: "/Applications/Vibest.app/Contents/Resources",
      devUrl: undefined,
      token: "fixed-token",
    });

    expect(config.serverEntry).toBe(
      "/Applications/Vibest.app/Contents/Resources/app.asar/node_modules/@vibest/server/dist/server.mjs",
    );
    expect(config.token).toBe("fixed-token");
  });

  it("resolves the dev server entry relative to the package output", () => {
    const config = buildDesktopConfig({
      isPackaged: false,
      resourcesPath: "/unused",
      devUrl: undefined,
      token: "fixed-token",
    });

    expect(config.serverEntry).toMatch(/packages\/server\/dist\/server\.mjs$/);
  });
});
