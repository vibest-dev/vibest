import { z } from "zod";

export const HarnessAgentIdSchema = z.enum(["claude-code", "codex"]);
export type HarnessAgentId = z.infer<typeof HarnessAgentIdSchema>;
