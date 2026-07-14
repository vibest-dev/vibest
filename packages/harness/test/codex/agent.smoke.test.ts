import { describe, expect, it } from "vitest";

import { CodexAgent } from "../../src/codex/agent";

describe.skipIf(process.env.CODEX_SMOKE !== "1")("codex live smoke", () => {
  it("runs one real turn", { timeout: 120_000 }, async () => {
    const agent = new CodexAgent();
    const { sessionId } = await agent.session.create({ workspacePath: process.cwd() });
    const seen: string[] = [];
    for await (const chunk of agent.session.prompt({
      sessionId,
      text: "Reply with exactly: PONG",
    })) {
      seen.push(chunk.type);
    }
    expect(seen).toContain("finish");
    await agent.session.abort(sessionId);
  });
});
