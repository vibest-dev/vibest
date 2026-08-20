import { expect, it } from "vitest";

import { makeClaudeCodeAdapter, type ClaudeCodeAgent } from "../../src/harness/claude-code";
import { makeCodexAdapter, type CodexAgent } from "../../src/harness/codex";
import { makeGrokAdapter, type GrokAgent } from "../../src/harness/grok";
import { makePiAdapter, type PiAgent } from "../../src/harness/pi";

// Permission declarations are pure values that never touch the agent, so a
// stub is enough to lock each harness's declared subset of vibest's permission
// vocabulary and the default it wants the UI to preselect.
const stub = <T>() => ({}) as T;

it("claude-code declares plan/ask/acceptEdits/full, defaulting to full", () => {
  const adapter = makeClaudeCodeAdapter(stub<ClaudeCodeAgent>());

  expect(adapter.permissionModes).toEqual(["plan", "ask", "acceptEdits", "full"]);
  expect(adapter.defaultPermissionMode).toBe("full");
});

it("codex declares read-only/ask/full (no plan), defaulting to ask", () => {
  const adapter = makeCodexAdapter(stub<CodexAgent>());

  expect(adapter.permissionModes).toEqual(["read-only", "ask", "full"]);
  // Deliberately not "full": codex's full access also drops the sandbox.
  expect(adapter.defaultPermissionMode).toBe("ask");
});

it("pi declares an empty permission subset and no default", () => {
  const adapter = makePiAdapter(stub<PiAgent>());

  expect(adapter.permissionModes).toEqual([]);
  expect(adapter.defaultPermissionMode).toBeUndefined();
});

it("grok declares ask/full, defaulting to ask", () => {
  const adapter = makeGrokAdapter(stub<GrokAgent>());

  expect(adapter.permissionModes).toEqual(["ask", "full"]);
  expect(adapter.defaultPermissionMode).toBe("ask");
});

it("only the harnesses with a model catalogue declare a probe", () => {
  expect(makeClaudeCodeAdapter(stub<ClaudeCodeAgent>()).probeModels).toBeDefined();
  expect(makeCodexAdapter(stub<CodexAgent>()).probeModels).toBeDefined();
  expect(makeGrokAdapter(stub<GrokAgent>()).probeModels).toBeDefined();
  // Absent, not empty: pi has no model switch, so the client renders no picker.
  expect(makePiAdapter(stub<PiAgent>()).probeModels).toBeUndefined();
});

it("declaring an adapter never touches its agent", () => {
  // Construction has to stay a pure declaration — the stubs above would throw
  // on any property access if a probe were built eagerly rather than per call.
  expect(() => makeClaudeCodeAdapter(stub<ClaudeCodeAgent>())).not.toThrow();
  expect(() => makeCodexAdapter(stub<CodexAgent>())).not.toThrow();
  expect(() => makeGrokAdapter(stub<GrokAgent>())).not.toThrow();
});
