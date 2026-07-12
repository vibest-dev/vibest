import { z } from "zod/v4";

export const HarnessAgentIdSchema = z.enum(["claude-code", "codex"]);
export type HarnessAgentId = z.infer<typeof HarnessAgentIdSchema>;
