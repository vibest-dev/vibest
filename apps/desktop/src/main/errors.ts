import { Data } from "effect";

export class BackendSpawnError extends Data.TaggedError("BackendSpawnError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class BackendReadyTimeout extends Data.TaggedError("BackendReadyTimeout")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export class BackendExitedBeforeReady extends Data.TaggedError("BackendExitedBeforeReady")<{
  readonly exitCode: number | null;
  readonly message: string;
}> {}

export type BackendStartError = BackendSpawnError | BackendReadyTimeout | BackendExitedBeforeReady;

export class DesktopProtocolRegistrationError extends Data.TaggedError(
  "DesktopProtocolRegistrationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
