import type { AgentRequest, AgentRequestAction, AgentResponse } from "@vibest/contract";

import type { PermissionOption, RequestPermissionParams, RpcServerRequest } from "./protocol";

const FALLBACK_ACTIONS: AgentRequestAction[] = [
  { id: "allow-once", label: "Allow", behavior: "allow", variant: "primary" },
  { id: "reject-once", label: "Deny", behavior: "deny" },
];

const kindBehavior = (kind: string | undefined): AgentRequestAction["behavior"] =>
  kind?.startsWith("reject") || kind?.startsWith("deny") ? "deny" : "allow";

const toAction = (option: PermissionOption): AgentRequestAction => ({
  id: option.optionId,
  label: option.name ?? option.optionId,
  behavior: kindBehavior(option.kind),
  ...(option.kind?.includes("always") || option.kind?.includes("session")
    ? { grant: { type: "session" as const } }
    : {}),
});

const toolNameOf = (params: RequestPermissionParams): string => {
  const meta = params.toolCall?.["_meta"];
  if (typeof meta === "object" && meta !== null) {
    const tool = (meta as { "x.ai/tool"?: { name?: unknown } })["x.ai/tool"];
    if (typeof tool?.name === "string") return tool.name;
  }
  return params.toolCall?.title ?? "tool";
};

export function buildPermissionRequest(request: RpcServerRequest): AgentRequest {
  const params = (request.params ?? {}) as RequestPermissionParams;
  const options = params.options ?? [];
  const actions = options.length > 0 ? options.map(toAction) : FALLBACK_ACTIONS;
  return {
    type: "tool",
    id: String(request.id),
    harnessAgentId: "grok",
    toolName: toolNameOf(params),
    input:
      typeof params.toolCall?.rawInput === "object" && params.toolCall.rawInput !== null
        ? (params.toolCall.rawInput as Record<string, unknown>)
        : {},
    actions,
    ...(params.toolCall?.title ? { title: params.toolCall.title } : {}),
    native: params,
  };
}

export function mapPermissionResponse(response: AgentResponse): unknown {
  if (response.type === "question") {
    return { outcome: { outcome: "cancelled" } };
  }
  if (response.behavior === "deny") {
    const optionId = response.type === "tool" ? response.selectedActionId : undefined;
    return {
      outcome: {
        outcome: "selected",
        optionId: optionId ?? "reject-once",
      },
    };
  }
  const optionId = response.type === "tool" ? response.selectedActionId : undefined;
  return {
    outcome: {
      outcome: "selected",
      optionId: optionId ?? "allow-once",
    },
  };
}

export const cancelledPermissionResult = { outcome: { outcome: "cancelled" } } as const;
