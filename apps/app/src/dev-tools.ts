/**
 * Dev-only inspectors, started from `app-interface.tsx` behind an
 * `import.meta.env.DEV` guard — the guard is statically false in production, so
 * this whole module drops out of both the Vite and electron-vite builds.
 *
 *   - react-grab (https://react-grab.com) — hover any element and press
 *     Cmd/Ctrl+C to copy it with its React component stack and source
 *     locations, for pasting into a coding agent.
 *   - react-scan (https://react-scan.com) — highlights components as they
 *     re-render so you can spot wasted renders. Loaded a tick later than its
 *     ideal "before React" position, so it may miss the very first render.
 *
 * Both fire the same version check against react-grab.com on init, which the
 * Electron renderer's `connect-src 'self' vibest: 127.0.0.1` CSP blocks — a
 * console error each, on every startup. Turning the telemetry off at the source
 * beats widening that CSP, which would only be needed in dev and would let
 * violations reach production unnoticed.
 *
 * react-grab honours `telemetry: false`, but only through an explicit `init`,
 * and importing the package auto-inits with the defaults — hence its documented
 * `__REACT_GRAB_DISABLED__` escape hatch, then init by hand. react-scan bundles
 * its own copy of the check with no opt-out, and skips it once
 * `window.__REACT_GRAB__` is set, which is what `setGlobalApi` does: the order
 * below is load-bearing.
 */
// oxlint-disable no-underscore-dangle -- react-grab's own global flag name
export async function startDevTools(): Promise<void> {
  window.__REACT_GRAB_DISABLED__ = true;
  const { init, setGlobalApi } = await import("react-grab");
  delete window.__REACT_GRAB_DISABLED__;
  // `setGlobalApi` is what publishes `window.__REACT_GRAB__`, and it also
  // flushes plugins registered before init.
  const api = init({ telemetry: false });
  setGlobalApi(api);
  // What the auto-init path announces; devtools integrations watch for it.
  window.dispatchEvent(new CustomEvent("react-grab:init", { detail: api }));

  const { scan } = await import("react-scan");
  scan();
}
