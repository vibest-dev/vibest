import { Button } from "@vibest/ui/components/button";
import { Label } from "@vibest/ui/components/label";
import { Radio, RadioGroup } from "@vibest/ui/components/radio-group";
import { Textarea } from "@vibest/ui/components/textarea";
import { useState } from "react";

import type {
  AgentRequest,
  AgentResponse,
  PlanApprovalMode,
} from "@/features/chat/runtime/agent-requests";

type PlanRequest = Extract<AgentRequest, { type: "plan" }>;

type ApprovalValue = "manual" | "autoEdit" | "bypass";
type SelectedValue = ApprovalValue | "revise";

const REVISE_VALUE = "revise";

const APPROVAL_OPTIONS = {
  manual: {
    label: "Manually approve actions",
    desc: "Approve each action one by one.",
    mode: "default",
  },
  autoEdit: {
    label: "Auto-approve edits",
    desc: "Automatically approve file edits for this session.",
    mode: "acceptEdits",
  },
  bypass: {
    label: "Bypass all permission prompts",
    desc: "Skip all permission checks for this session. Use with care.",
    mode: "bypassPermissions",
  },
} as const satisfies Record<ApprovalValue, { label: string; desc: string; mode: PlanApprovalMode }>;

const APPROVAL_VALUES: ApprovalValue[] = ["manual", "autoEdit", "bypass"];

// Plan approval card (ExitPlanMode): approve picks the permission mode the
// session continues in; revise sends feedback back as a deny message so the
// agent reworks the plan; dismiss hard-interrupts.
export function PlanRequestView({
  request,
  onRespond,
}: {
  request: PlanRequest;
  onRespond: (requestId: string, response: AgentResponse) => void;
}) {
  const [selected, setSelected] = useState<SelectedValue>("manual");
  const [feedback, setFeedback] = useState("");

  const isRevise = selected === REVISE_VALUE;

  const handleSubmit = () => {
    if (isRevise) {
      onRespond(request.id, { type: "plan", behavior: "deny", message: feedback });
      return;
    }
    onRespond(request.id, {
      type: "plan",
      behavior: "allow",
      mode: APPROVAL_OPTIONS[selected as ApprovalValue].mode,
    });
  };

  const handleDismiss = () => {
    onRespond(request.id, { type: "plan", behavior: "deny", interrupt: true });
  };

  return (
    <div className="border-border bg-card rounded-lg border text-sm">
      <div className="max-h-64 overflow-y-auto p-3">
        <p className="text-foreground font-medium">Plan</p>
        <pre className="text-foreground text-sm whitespace-pre-wrap">{request.plan}</pre>
      </div>

      <div className="border-border/50 space-y-3 border-t px-3 py-3">
        <p className="text-foreground text-sm font-medium">Ready to implement?</p>

        <RadioGroup value={selected} onValueChange={(v) => setSelected(v as SelectedValue)}>
          {APPROVAL_VALUES.map((value) => (
            <Label
              key={value}
              className="border-border/70 hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5"
            >
              <Radio value={value} />
              <div className="flex flex-col">
                <span className="text-foreground text-sm">{APPROVAL_OPTIONS[value].label}</span>
                <span className="text-muted-foreground text-xs">
                  {APPROVAL_OPTIONS[value].desc}
                </span>
              </div>
            </Label>
          ))}
          <Label className="border-border/70 hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5">
            <Radio value={REVISE_VALUE} />
            <div className="flex flex-col">
              <span className="text-foreground text-sm">Request changes</span>
              <span className="text-muted-foreground text-xs">
                Send feedback and ask for a revised plan.
              </span>
            </div>
          </Label>
        </RadioGroup>

        {isRevise && (
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change?"
            className="min-h-16 text-sm"
          />
        )}

        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleDismiss}>
            Dismiss
          </Button>
          <Button type="button" size="sm" onClick={handleSubmit}>
            {isRevise ? "Request changes" : "Approve"}
          </Button>
        </div>
      </div>
    </div>
  );
}
