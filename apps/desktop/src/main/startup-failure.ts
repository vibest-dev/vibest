import type { BackendStartError } from "./backend/local-backend";
import type { ProtocolRegistrationError } from "./electron/app-protocol";

export type DesktopStartupError = BackendStartError | ProtocolRegistrationError;

/** Turn a typed startup failure into the user-facing error dialog body. */
export function formatStartupFailure(error: DesktopStartupError): string {
  switch (error._tag) {
    case "BackendSpawnError":
      return `The local server could not be started.\n\n${error.message}`;
    case "BackendReadyTimeout":
      return `The local server did not become ready within ${Math.round(error.timeoutMs / 1000)} seconds.`;
    case "BackendExitedBeforeReady":
      return error.exitCode === null
        ? "The local server exited during startup."
        : `The local server exited during startup with code ${error.exitCode}.`;
    case "ProtocolRegistrationError":
      return `The desktop could not register its internal protocol.\n\n${error.message}`;
  }
}
