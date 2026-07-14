import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { codeInspectorPlugin } from "code-inspector-plugin";
import type { PluginOption } from "vite";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

/**
 * The `@` alias, resolved absolutely. The desktop renderer builds this app's
 * source from another package's directory, so a relative alias would break.
 */
export function appAlias(): Record<string, string> {
  return { "@": srcDir };
}

/**
 * Every plugin the app's source needs to compile. Shared by this package's own
 * Vite config and by apps/desktop's electron-vite renderer config, which
 * compiles the same source into the Electron bundle.
 */
export function appVitePlugins(): PluginOption[] {
  return [
    codeInspectorPlugin({ bundler: "vite" }),
    // The TanStack Router plugin must come before JSX transform plugins.
    tanstackRouter({
      target: "react",
      // No `verboseFileRoutes: false` — router-plugin 1.168 does not support it
      // (the option is silently ignored), so routes must spell out their path
      // and import createFileRoute themselves.
      autoCodeSplitting: true,
      // Absolute paths: consumers (apps/desktop, and tools like oxfmt/oxlint)
      // load this config with a different cwd, where plugin-relative paths
      // would resolve incorrectly.
      routesDirectory: fileURLToPath(new URL("./src/routes", import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL("./src/routeTree.gen.ts", import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ];
}
