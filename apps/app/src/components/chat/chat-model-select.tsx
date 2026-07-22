import { useChatSession } from "./chat-session-context";
import { ModelSelect } from "./model-select";

// Session-config slot: binds the presentational ModelSelect to the ChatSession
// context so it can be composed anywhere inside ChatSessionProvider (e.g. the
// composer toolbar). Renders nothing when the harness has no model switch.
export function ChatModelSelect() {
  const { models, model, setModel } = useChatSession();
  return <ModelSelect models={models} value={model} onChange={setModel} />;
}
