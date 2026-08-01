import type { ClaudeCodeTools } from "@vibest/contract/claude-code";
import type { DynamicToolUIPart, ToolUIPart, UIDataTypes, UIMessage } from "ai";
import type { ReactNode } from "react";

import { ClaudeCodeBashTool } from "@/features/chat/claude-code/bash-tool";
import { ClaudeCodeEditTool } from "@/features/chat/claude-code/edit-tool";
import { ClaudeCodeGlobTool } from "@/features/chat/claude-code/glob-tool";
import { ClaudeCodeGrepTool } from "@/features/chat/claude-code/grep-tool";
import { ClaudeCodeReadTool } from "@/features/chat/claude-code/read-tool";
import { ClaudeCodeTaskOutputTool } from "@/features/chat/claude-code/task-output-tool";
import { ClaudeCodeTaskTool } from "@/features/chat/claude-code/task-tool";
import { ClaudeCodeTodoWriteTool } from "@/features/chat/claude-code/todo-write-tool";
import { ClaudeCodeWebFetchTool } from "@/features/chat/claude-code/web-fetch-tool";
import { ClaudeCodeWebSearchTool } from "@/features/chat/claude-code/web-search-tool";
import { ClaudeCodeWriteTool } from "@/features/chat/claude-code/write-tool";

import { DynamicToolPart } from "../../dynamic-tool-part";
import { claudeCodeDynamicToolName } from "./dynamic-name";

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ClaudeCodeMessage = UIMessage<unknown, UIDataTypes, ClaudeCodeTools>;

// The claude-code per-tool render registry. The switch is EXHAUSTIVE over every
// tool in `ClaudeCodeTools`: typed tools with a dedicated card dispatch to it;
// typed tools without one render through the generic card at an explicit call
// site (not the caller's dynamic-tool fallback). The `default: satisfies never`
// makes a newly-registered tool a compile error here until it is placed in one
// bucket or the other — the UI-side complement to the harness registry guard.
//
// A true `dynamic-tool` part (an unknown MCP tool with no fixed type) returns
// null so the caller falls back to its own DynamicToolPart.
export function renderClaudeCodeTool(part: AnyToolPart, message: UIMessage): ReactNode | null {
  if (part.type === "dynamic-tool") return null;
  const typed = part as ToolUIPart<ClaudeCodeTools>;
  const typedMessage = message as ClaudeCodeMessage;

  // Typed tool with no dedicated card — the generic card, but reached here (not
  // via the caller's dynamic-tool path) so the switch below stays exhaustive.
  const generic = () => <DynamicToolPart part={typed} name={claudeCodeDynamicToolName(typed)} />;

  switch (typed.type) {
    // `Agent` is the current wire name; `Task` is its legacy alias, still found
    // on replayed transcripts. Both drive the subagent card.
    case "tool-Agent":
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
    case "tool-TaskOutput":
      return <ClaudeCodeTaskOutputTool invocation={typed} />;
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
    case "tool-Write":
      return <ClaudeCodeWriteTool invocation={typed} />;

    // Typed tools with no dedicated card yet — rendered generically. Listed so
    // the exhaustiveness check below fires when the registry gains a tool.
    case "tool-TaskStop":
    case "tool-TaskCreate":
    case "tool-TaskUpdate":
    case "tool-TaskGet":
    case "tool-TaskList":
    case "tool-NotebookEdit":
    case "tool-AskUserQuestion":
    case "tool-EnterPlanMode":
    case "tool-ExitPlanMode":
    case "tool-EnterWorktree":
    case "tool-ExitWorktree":
    case "tool-ReportFindings":
    case "tool-Workflow":
    case "tool-ScheduleWakeup":
    case "tool-Monitor":
    case "tool-CronCreate":
    case "tool-CronDelete":
    case "tool-CronList":
    case "tool-RemoteTrigger":
    case "tool-PushNotification":
    case "tool-ListMcpResourcesTool":
    case "tool-ReadMcpResourceTool":
    case "tool-ReadMcpResourceDirTool":
    case "tool-DesignSync":
    case "tool-Artifact":
    case "tool-REPL":
    case "tool-Projects":
    case "tool-ShowOnboardingRolePicker":
    case "tool-RefreshMcpTools":
    case "tool-SendFeedback":
    case "tool-propose_skills":
      return generic();

    default:
      typed satisfies never;
      return generic();
  }
}
