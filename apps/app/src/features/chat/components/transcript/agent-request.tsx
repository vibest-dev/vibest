import type { AgentRequest, AgentResponse } from "@/features/chat/runtime/agent-requests";

import { PlanRequestView } from "./plan-request";
import { QuestionRequestView } from "./question-request";
import { ToolRequestView } from "./tool-request";

// Routes a request to the view for its `type` (the Tier-1 discriminant).
// Each request type owns a dedicated component; this file is routing only.
export function AgentRequestView({
  request,
  onRespond,
}: {
  request: AgentRequest;
  onRespond: (requestId: string, response: AgentResponse) => void;
}) {
  switch (request.type) {
    case "question":
      return <QuestionRequestView request={request} onRespond={onRespond} />;
    case "plan":
      return <PlanRequestView request={request} onRespond={onRespond} />;
    case "tool":
      return <ToolRequestView request={request} onRespond={onRespond} />;
  }
}
