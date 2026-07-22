import { expect, it } from "vitest";

import { makeClaudeCodeAdapter, type ClaudeCodeAgent } from "../../src/harness/claude-code";
import { makeCodexAdapter, type CodexAgent } from "../../src/harness/codex";
import { makePiAdapter, type PiAgent } from "../../src/harness/pi";

// Static capabilities are a pure declaration that never touches the agent, so a
// stub is enough to lock each harness's outward permission vocabulary and the
// default it wants the UI to preselect.
const stub = <T>() => ({}) as T;

it("claude-code negotiates plan/ask/acceptEdits/full, defaulting to full", () => {
  const caps = makeClaudeCodeAdapter(stub<ClaudeCodeAgent>()).capabilities;

  expect(caps.permissionModes?.map((mode) => mode.id)).toEqual([
    "plan",
    "ask",
    "acceptEdits",
    "full",
  ]);
  expect(caps.defaultPermissionMode).toBe("full");
});

it("codex negotiates read-only/ask/full (no plan), defaulting to ask", () => {
  const caps = makeCodexAdapter(stub<CodexAgent>()).capabilities;

  expect(caps.permissionModes?.map((mode) => mode.id)).toEqual(["read-only", "ask", "full"]);
  // Deliberately not "full": codex's full access also drops the sandbox.
  expect(caps.defaultPermissionMode).toBe("ask");
});

it("pi negotiates neither permission modes nor a default", () => {
  const caps = makePiAdapter(stub<PiAgent>()).capabilities;

  expect(caps.permissionModes).toBeUndefined();
  expect(caps.defaultPermissionMode).toBeUndefined();
});

it("only the harnesses with a runtime catalog declare a probe", () => {
  expect(makeClaudeCodeAdapter(stub<ClaudeCodeAgent>()).probeCatalog).toBeDefined();
  expect(makeCodexAdapter(stub<CodexAgent>()).probeCatalog).toBeDefined();
  // Absent, not empty: pi has no model switch, so the client renders no picker.
  expect(makePiAdapter(stub<PiAgent>()).probeCatalog).toBeUndefined();
});

it("declaring an adapter never touches its agent", () => {
  // Construction has to stay a pure declaration — the stubs above would throw
  // on any property access if a probe were built eagerly rather than per call.
  expect(() => makeClaudeCodeAdapter(stub<ClaudeCodeAgent>())).not.toThrow();
  expect(() => makeCodexAdapter(stub<CodexAgent>())).not.toThrow();
});
