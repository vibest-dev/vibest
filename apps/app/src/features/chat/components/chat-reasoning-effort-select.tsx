import { useChatSession } from "./chat-session-context";
import { ReasoningEffortSelect } from "./reasoning-effort-select";

// Session-config slot: binds the presentational ReasoningEffortSelect to the ChatSession
// context. Its candidates cascade from the currently selected model, so the
// control appears and disappears as the model selection changes; nothing
// renders when the model has no reasoningEffort switch.
export function ChatReasoningEffortSelect() {
  const { reasoningEfforts, reasoningEffort, setReasoningEffort } = useChatSession();
  return (
    <ReasoningEffortSelect
      reasoningEfforts={reasoningEfforts}
      value={reasoningEffort}
      onChange={setReasoningEffort}
    />
  );
}
