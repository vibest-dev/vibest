import type { ToolPermissionRequest } from "@vibest/contract/claude-code";

import type { AgentRequest, AgentRequestAction, AgentResponse } from "./agent-requests";

type PermissionUpdate = NonNullable<ToolPermissionRequest["suggestions"]>[number];

type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: "deny"; message: string; interrupt?: boolean };

// The claude-code boundary: wire events become provider-free AgentRequests here
// and provider detail (suggestions, original input) never enters the React tree.

export function toAgentRequest(event: ToolPermissionRequest): AgentRequest {
  const actions: AgentRequestAction[] = [
    { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
    ...(event.suggestions?.length
      ? [
          {
            id: "grant:session",
            label: "Allow for this session",
            behavior: "allow",
            grant: { type: "session" },
          } satisfies AgentRequestAction,
        ]
      : []),
    { id: "deny", label: "Deny", behavior: "deny" },
  ];
  return {
    type: "tool",
    id: event.requestId,
    toolName: event.toolName,
    input: event.input,
    actions,
  };
}

export function toPermissionResult(
  event: ToolPermissionRequest,
  response: AgentResponse,
): PermissionResult {
  if (response.behavior === "allow") {
    const result: PermissionResult = { behavior: "allow", updatedInput: event.input };
    // A session grant re-scopes the SDK's suggested permission rules to this
    // session and rides back on the allow.
    if (response.grant?.type === "session" && event.suggestions?.length) {
      result.updatedPermissions = event.suggestions.map((s) =>
        "destination" in s ? { ...s, destination: "session" as const } : s,
      );
    }
    return result;
  }
  return {
    behavior: "deny",
    message: "User denied the permission request",
    interrupt: response.interrupt,
  };
}
