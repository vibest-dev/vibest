import { oc, type } from "@orpc/contract";
import type { AgentRequest, AgentResponse } from "@vibest/harness";
import type { CodexUIMessageChunk } from "@vibest/harness/codex";
import { z } from "zod";

export const codexContract = {
  session: {
    create: oc.input(z.object({ workspacePath: z.string() })).output(type<{ sessionId: string }>()),
    abort: oc.input(z.object({ sessionId: z.string() })),
  },
  prompt: oc
    .input(z.object({ sessionId: z.string(), text: z.string() }))
    .output(type<AsyncGenerator<CodexUIMessageChunk>>()),
  requestPermission: oc
    .input(z.object({ sessionId: z.string() }))
    .output(type<AsyncGenerator<AgentRequest>>()),
  respondPermission: oc.input(
    z.object({
      sessionId: z.string(),
      requestId: z.string(),
      response: z.custom<AgentResponse>(),
    }),
  ),
};
