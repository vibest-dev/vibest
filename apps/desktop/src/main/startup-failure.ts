import type { ProtocolRegistrationError } from "./electron/app-protocol";

/** Turn a typed shell startup failure into the user-facing error dialog body. */
export function formatStartupFailure(error: ProtocolRegistrationError): string {
  return `The desktop could not register its internal protocol.\n\n${error.message}`;
}
