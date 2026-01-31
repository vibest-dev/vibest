import { defineConfig } from "tsdown";

export default defineConfig([
  {
    clean: false,
    entry: "src/background.ts",
    format: "iife",
    outputOptions: {
      file: "dist/background.js",
    },
    tsconfig: true,
    noExternal: [/^webext-bridge\/.*/, "webextension-polyfill"],
  },
  {
    clean: false,
    entry: ["src/content.ts"],
    format: "iife",
    outputOptions: {
      file: "dist/content.js",
    },
    tsconfig: true,
    noExternal: [/^webext-bridge\/.*/],
  },
  {
    clean: false,
    entry: ["src/content-main-world.ts"],
    format: "iife",
    outputOptions: {
      file: "dist/content-main-world.js",
    },
    tsconfig: true,
    noExternal: [/^webext-bridge\/.*/],
  },
]);
