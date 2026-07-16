import type { ReactElement } from "react";
import type { FallbackProps } from "react-error-boundary";

export function StartupFailure({ error }: FallbackProps): ReactElement {
  const message =
    error instanceof Error
      ? error.message
      : "The desktop shell did not provide a valid connection.";
  return (
    <main className="grid min-h-svh place-items-center p-8 font-sans">
      <div className="max-w-lg text-center">
        <h1 className="text-xl font-medium">Vibest could not start</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{message}</p>
      </div>
    </main>
  );
}
