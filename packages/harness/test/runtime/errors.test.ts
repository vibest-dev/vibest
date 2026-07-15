import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  AgentProcessExited,
  CodexRpcError,
  HarnessAgentNotFound,
  SessionNotFound,
} from "../../src/runtime/errors";

const isHarnessAgentNotFound = Schema.is(HarnessAgentNotFound);

describe("runtime errors", () => {
  it("preserves routing fields on tagged errors", () => {
    const error = new HarnessAgentNotFound({ harnessAgentId: "codex" });

    expect(error._tag).toBe("HarnessAgentNotFound");
    expect(error.harnessAgentId).toBe("codex");
    expect(isHarnessAgentNotFound(error)).toBe(true);
  });

  it("keeps protocol and process diagnostics typed", () => {
    const rpcError = new CodexRpcError({
      method: "turn/start",
      code: -32603,
      errorMessage: "internal error",
    });
    const exited = new AgentProcessExited({ harnessAgentId: "codex", code: 1 });
    const missing = new SessionNotFound({ sessionId: "session-1" });

    expect(rpcError.message).toContain("turn/start");
    expect(exited.message).toContain("code 1");
    expect(missing.message).toContain("session-1");
  });
});
