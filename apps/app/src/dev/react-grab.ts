/**
 * Dev-only wiring for React Grab (https://react-grab.com).
 *
 * In development, this lets you hover any UI element and press ⌘C / Ctrl+C to
 * copy the element together with its React component stack and source locations
 * — ready to paste into a coding agent.
 *
 * The `import.meta.env.DEV` guard is statically false in production builds, so
 * both Vite (web) and electron-vite (desktop renderer) dead-code-eliminate the
 * dynamic import and React Grab never ships. Imported for its side effect from
 * `app.tsx`, so both the web entry and the Electron renderer pick it up.
 */
if (import.meta.env.DEV) {
  void import("react-grab");
}
