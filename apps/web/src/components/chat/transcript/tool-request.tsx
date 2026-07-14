import { Button } from "@vibest/ui/components/button";

import {
  buildToolResponse,
  type AgentRequest,
  type AgentRequestAction,
  type AgentResponse,
} from "@/core/chat/agent-requests";

type ToolRequest = Extract<AgentRequest, { type: "tool" }>;

function buttonVariant(
  variant: AgentRequestAction["variant"],
): "default" | "outline" | "destructive" {
  if (variant === "primary") return "default";
  if (variant === "danger") return "destructive";
  return "outline";
}

// Compact read-only summary of tool input (unknown shape).
function InputSummary({ input }: { input: unknown }) {
  if (input == null) return null;
  const text =
    typeof input === "object"
      ? Object.entries(input as Record<string, unknown>)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${String(v)}`)
          .join("\n")
      : String(input);
  if (!text) return null;
  return (
    <pre className="bg-muted text-muted-foreground overflow-x-auto rounded px-2 py-1 text-xs">
      {text}
    </pre>
  );
}

export function ToolRequestView({
  request,
  onRespond,
}: {
  request: ToolRequest;
  onRespond: (requestId: string, response: AgentResponse) => void;
}) {
  return (
    <div className="border-border bg-card rounded-lg border p-3 text-sm">
      <p className="font-medium">{request.description ?? "Allow this action?"}</p>
      {request.title && <p className="text-muted-foreground mt-0.5">{request.title}</p>}
      <p className="text-muted-foreground mt-0.5 font-mono text-xs">{request.toolName}</p>
      {request.input != null && (
        <div className="mt-2">
          <InputSummary input={request.input} />
        </div>
      )}
      <div className="mt-3 flex flex-col gap-2.5">
        {request.actions.map((action, index) => (
          <Button
            key={action.id}
            type="button"
            variant={buttonVariant(action.variant)}
            size="sm"
            className="h-auto w-full justify-start gap-3 py-1.5 pl-1.5"
            onClick={() => onRespond(request.id, buildToolResponse(action))}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums opacity-70">
              {index + 1}
            </span>
            <span className="truncate">{action.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
