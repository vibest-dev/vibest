// Placeholder types until the codex adapter lands (design §1: codex is a first-class
// design target, implementation deferred). Keeps the envelope union total.
import type { UIMessage, UITools } from "ai";

export type CodexMetadata = unknown;
export type CodexDataTypes = Record<string, never>;
export type CodexTools = UITools;
export type CodexUIMessage = UIMessage<CodexMetadata, CodexDataTypes, CodexTools>;
