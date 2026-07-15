import { describe, expect, it } from "vitest";

import {
  BackendExitedBeforeReady,
  BackendReadyTimeout,
  BackendSpawnError,
} from "./backend/local-backend";
import { ProtocolRegistrationError } from "./electron/app-protocol";
import { formatStartupFailure } from "./startup-failure";

describe("formatStartupFailure", () => {
  it("describes a spawn failure", () => {
    const message = formatStartupFailure(
      new BackendSpawnError({ message: "Unable to start the backend process: ENOENT" }),
    );
    expect(message).toContain("could not be started");
    expect(message).toContain("ENOENT");
  });

  it("describes a ready timeout in seconds", () => {
    const message = formatStartupFailure(
      new BackendReadyTimeout({ timeoutMs: 30_000, message: "timed out" }),
    );
    expect(message).toContain("30 seconds");
  });

  it("describes an early exit with its code", () => {
    const message = formatStartupFailure(
      new BackendExitedBeforeReady({ exitCode: 7, message: "exited" }),
    );
    expect(message).toContain("exited during startup with code 7");
  });

  it("describes an early exit without a code", () => {
    const message = formatStartupFailure(
      new BackendExitedBeforeReady({ exitCode: null, message: "exited" }),
    );
    expect(message).toBe("The local server exited during startup.");
  });

  it("describes a protocol registration failure", () => {
    const message = formatStartupFailure(
      new ProtocolRegistrationError({ message: "Unable to register the vibest protocol" }),
    );
    expect(message).toContain("internal protocol");
  });
});
