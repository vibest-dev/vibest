import type { CodexTools } from "@vibest/harness/codex";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  FilePenLineIcon,
  ImageIcon,
  type LucideIcon,
  SearchIcon,
  SquareTerminalIcon,
  UsersIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { CodexToolCard } from "@/components/codex/codex-tool-card";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

// Icon + label per typed codex tool. Cards are input/output-only for now, so a
// lookup table beats one thin component file per tool.
const CODEX_TOOL_META: Record<ToolUIPart<CodexTools>["type"], { icon: LucideIcon; label: string }> =
  {
    "tool-commandExecution": { icon: SquareTerminalIcon, label: "Command" },
    "tool-fileChange": { icon: FilePenLineIcon, label: "File change" },
    "tool-webSearch": { icon: SearchIcon, label: "Web search" },
    "tool-collabAgentToolCall": { icon: UsersIcon, label: "Collab agent" },
    "tool-imageGeneration": { icon: ImageIcon, label: "Image generation" },
    "tool-imageView": { icon: ImageIcon, label: "Image view" },
  };

// The codex per-tool render registry, symmetric with renderClaudeCodeTool:
// typed tool-* parts render as a simple input/output card; anything
// unrecognized returns null so the caller falls back to the generic
// DynamicToolPart. The cast is the provider trust boundary — the harness
// transform guarantees tool-* parts of this provider match CodexTools.
export function renderCodexTool(part: AnyToolPart): ReactNode | null {
  if (part.type === "dynamic-tool" || part.state === "input-streaming") return null;
  const meta = CODEX_TOOL_META[part.type as ToolUIPart<CodexTools>["type"]];
  if (!meta) return null;
  const output = part.state === "output-available" ? part.output : undefined;
  return <CodexToolCard icon={meta.icon} title={meta.label} input={part.input} output={output} />;
}
