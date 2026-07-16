import type { ReactElement } from "react";

import "./startup-screen.css";

const VIBEST_V = `████    ████
████    ████
  ████████
  ████████
    ████
    ████`;

export function StartupScreen(): ReactElement {
  return (
    <main
      className="bg-background fixed inset-0 z-40 grid place-items-center"
      aria-label="Starting Vibest"
    >
      <div className="vibest-startup-logo" aria-hidden="true">
        <pre>{VIBEST_V}</pre>
      </div>
    </main>
  );
}
