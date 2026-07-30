import assert from "node:assert/strict";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { makeClaudeCodeAgent } from "../../../src/harness/claude-code/agent";

const fakeClaude = path.resolve(
  import.meta.dirname,
  "../../../../../tools/testing/fake-claude.mjs",
);

it.effect("communicates with Claude Agent SDK through a fake Claude executable", () =>
  Effect.gen(function* () {
    const agent = yield* makeClaudeCodeAgent({
      env: {
        ...process.env,
        VIBEST_E2E: "1",
        VIBEST_E2E_CLAUDE_EXECUTABLE: fakeClaude,
      },
    });
    const { sessionId } = yield* agent.session.create();

    assert.deepStrictEqual(yield* agent.session.getSupportedModels(sessionId), [
      {
        value: "fake-claude",
        displayName: "Fake Claude",
        description: "Deterministic Claude executable used by Vibest tests",
      },
    ]);
    assert.deepStrictEqual(yield* agent.session.getMcpServers(sessionId), []);

    const turn = yield* agent.session.prompt({
      sessionId,
      message: { role: "user", content: "SDK integration" },
    });
    const output = yield* Stream.runCollect(turn.output);
    const assistant = Array.from(output).find((message) => message.type === "assistant");

    assert.deepStrictEqual(assistant?.message.content, [
      { type: "text", text: "Fake Claude received: SDK integration" },
    ]);
  }),
);
