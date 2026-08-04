import { Button } from "@vibest/ui/components/button";
import { Checkbox } from "@vibest/ui/components/checkbox";
import { Label } from "@vibest/ui/components/label";
import { Radio, RadioGroup } from "@vibest/ui/components/radio-group";
import { useState } from "react";

import type {
  AgentRequest,
  AgentResponse,
  AgentResponseAnswer,
} from "@/features/chat/runtime/agent-requests";

type QuestionRequest = Extract<AgentRequest, { type: "question" }>;

type AnswerDraft = { selected: string[]; other: string };

const EMPTY_DRAFT: AnswerDraft = { selected: [], other: "" };

function QuestionItem({
  question,
  labelId,
  value,
  onChange,
}: {
  question: QuestionRequest["questions"][number];
  /** id of the <p> carrying the question text rendered just above this field. */
  labelId: string;
  value: AnswerDraft;
  onChange: (next: AnswerDraft) => void;
}) {
  const options = question.options ?? [];
  const isChoice = question.kind === "choice" && options.length > 0;

  if (!isChoice) {
    return (
      // The question itself is the label — pointing at it beats a placeholder,
      // which disappears on first keystroke and is not announced as a name.
      <input
        type="text"
        aria-labelledby={labelId}
        className="border-border/70 text-foreground placeholder:text-muted-foreground/70 focus:ring-ring w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:ring-1"
        placeholder="Type your answer…"
        value={value.selected[0] ?? ""}
        onChange={(e) => onChange({ ...value, selected: [e.target.value] })}
      />
    );
  }

  if (question.multiSelect) {
    const selected = new Set(value.selected);
    return (
      <div className="space-y-1">
        {options.map((opt) => (
          <Label
            key={opt.label}
            className="border-border/70 hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5"
          >
            <Checkbox
              checked={selected.has(opt.label)}
              onCheckedChange={(checked) => {
                const next = checked
                  ? [...value.selected, opt.label]
                  : value.selected.filter((v) => v !== opt.label);
                onChange({ ...value, selected: next });
              }}
            />
            <div className="flex flex-col">
              <span className="text-foreground text-sm">{opt.label}</span>
              {opt.description && (
                <span className="text-muted-foreground text-xs">{opt.description}</span>
              )}
            </div>
          </Label>
        ))}
      </div>
    );
  }

  return (
    <RadioGroup
      value={value.selected[0] ?? ""}
      onValueChange={(v) => onChange({ ...value, selected: [String(v)] })}
      className="gap-1"
    >
      {options.map((opt) => (
        <Label
          key={opt.label}
          className="border-border/70 hover:bg-accent/50 flex cursor-pointer items-start gap-2 rounded-lg border p-2.5"
        >
          <Radio value={opt.label} />
          <div className="flex flex-col">
            <span className="text-foreground text-sm">{opt.label}</span>
            {opt.description && (
              <span className="text-muted-foreground text-xs">{opt.description}</span>
            )}
          </div>
        </Label>
      ))}
    </RadioGroup>
  );
}

// Question card (AskUserQuestion): the agent asks for data mid-turn. Submit
// returns answers keyed by question id; cancel returns an empty answer set,
// which the boundary maps to a dismissal.
export function QuestionRequestView({
  request,
  onRespond,
}: {
  request: QuestionRequest;
  onRespond: (requestId: string, response: AgentResponse) => void;
}) {
  const [answers, setAnswers] = useState<AnswerDraft[]>(() =>
    request.questions.map(() => EMPTY_DRAFT),
  );

  const handleSubmit = () => {
    const builtAnswers: AgentResponseAnswer[] = request.questions.map((question, index) => {
      const draft = answers[index] ?? EMPTY_DRAFT;
      return {
        questionId: question.id,
        values: draft.selected.filter((v) => v !== ""),
        ...(draft.other !== "" ? { other: draft.other } : {}),
      };
    });
    onRespond(request.id, { type: "question", answers: builtAnswers });
  };

  const handleCancel = () => {
    onRespond(request.id, { type: "question", answers: [] });
  };

  return (
    <div className="border-border bg-card rounded-lg border p-3 text-sm">
      <div className="space-y-4">
        {request.questions.map((question, index) => (
          <div key={question.id} className="space-y-1.5">
            {question.header && (
              <p className="text-muted-foreground text-xs font-medium">{question.header}</p>
            )}
            <p id={`question-${question.id}`} className="text-foreground text-sm font-medium">
              {question.question}
            </p>
            <QuestionItem
              question={question}
              labelId={`question-${question.id}`}
              value={answers[index] ?? EMPTY_DRAFT}
              onChange={(next) =>
                setAnswers((prev) => prev.map((draft, i) => (i === index ? next : draft)))
              }
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={handleSubmit}>
          Submit
        </Button>
      </div>
    </div>
  );
}
