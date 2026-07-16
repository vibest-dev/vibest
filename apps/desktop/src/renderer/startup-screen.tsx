import type { ReactElement } from "react";

import vibestLogoUrl from "../../resources/v.svg?url";

import "./startup-screen.css";

export function StartupScreen(): ReactElement {
  return (
    <main
      className="bg-background fixed inset-0 z-40 grid place-items-center"
      aria-label="Starting Vibest"
    >
      <div
        className="vibest-startup-logo"
        style={{
          WebkitMaskImage: `url("${vibestLogoUrl}")`,
          maskImage: `url("${vibestLogoUrl}")`,
        }}
        aria-hidden="true"
      >
        <span className="vibest-startup-logo-shimmer" />
      </div>
    </main>
  );
}
