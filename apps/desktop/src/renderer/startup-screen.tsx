import type { ReactElement } from "react";

export function StartupScreen(): ReactElement {
  return (
    <main className="grid min-h-svh place-items-center p-8 font-sans">
      <div className="max-w-lg text-center">
        <h1 className="text-xl font-medium">Starting Vibest…</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Connecting to the desktop shell and local server.
        </p>
      </div>
    </main>
  );
}
