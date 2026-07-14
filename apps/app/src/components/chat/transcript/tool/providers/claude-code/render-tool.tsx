import type { ClaudeCodeTools } from "@vibest/harness/claude-code";
import type { DynamicToolUIPart, ToolUIPart, UIDataTypes, UIMessage } from "ai";
import type { ReactNode } from "react";

import { ClaudeCodeBashOutputTool } from "@/components/claude-code/bash-output-tool";
import { ClaudeCodeBashTool } from "@/components/claude-code/bash-tool";
import { ClaudeCodeEditTool } from "@/components/claude-code/edit-tool";
import { ClaudeCodeGlobTool } from "@/components/claude-code/glob-tool";
import { ClaudeCodeGrepTool } from "@/components/claude-code/grep-tool";
import { ClaudeCodeMultiEditTool } from "@/components/claude-code/multi-edit-tool";
import { ClaudeCodeReadTool } from "@/components/claude-code/read-tool";
import { ClaudeCodeSlashCommandTool } from "@/components/claude-code/slash-command-tool";
import { ClaudeCodeTaskTool } from "@/components/claude-code/task-tool";
import { ClaudeCodeTodoWriteTool } from "@/components/claude-code/todo-write-tool";
import { ClaudeCodeWebFetchTool } from "@/components/claude-code/web-fetch-tool";
import { ClaudeCodeWebSearchTool } from "@/components/claude-code/web-search-tool";
import { ClaudeCodeWriteTool } from "@/components/claude-code/write-tool";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ClaudeCodeMessage = UIMessage<unknown, UIDataTypes, ClaudeCodeTools>;

// The claude-code per-tool render registry: typed tool-* parts dispatch to
// their dedicated card; anything unrecognized (dynamic-tool / unknown MCP
// tools) returns null so the caller falls back to the generic DynamicToolPart.
// The cast is the provider trust boundary — the harness transform guarantees
// tool-* parts of this provider match ClaudeCodeTools.
export function renderClaudeCodeTool(part: AnyToolPart, message: UIMessage): ReactNode | null {
  if (part.type === "dynamic-tool") return null;
  const typed = part as ToolUIPart<ClaudeCodeTools>;
  const typedMessage = message as ClaudeCodeMessage;
  switch (typed.type) {
    case "tool-Task":
      return (
        <ClaudeCodeTaskTool
          message={typedMessage}
          invocation={typed}
          renderToolPart={(childPart) => renderClaudeCodeTool(childPart, message)}
        />
      );
    case "tool-Bash":
      return <ClaudeCodeBashTool invocation={typed} />;
    case "tool-BashOutput":
      return <ClaudeCodeBashOutputTool invocation={typed} />;
    case "tool-Read":
      return <ClaudeCodeReadTool invocation={typed} />;
    case "tool-Grep":
      return <ClaudeCodeGrepTool invocation={typed} />;
    case "tool-Edit":
      return <ClaudeCodeEditTool invocation={typed} />;
    case "tool-WebFetch":
      return <ClaudeCodeWebFetchTool invocation={typed} />;
    case "tool-WebSearch":
      return <ClaudeCodeWebSearchTool invocation={typed} />;
    case "tool-TodoWrite":
      return <ClaudeCodeTodoWriteTool invocation={typed} />;
    case "tool-Glob":
      return <ClaudeCodeGlobTool invocation={typed} />;
    case "tool-MultiEdit":
      return <ClaudeCodeMultiEditTool invocation={typed} />;
    case "tool-Write":
      return <ClaudeCodeWriteTool invocation={typed} />;
    case "tool-SlashCommand":
      return <ClaudeCodeSlashCommandTool message={typedMessage} invocation={typed} />;
    default:
      return null;
  }
}
