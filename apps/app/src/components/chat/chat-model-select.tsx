import { useChatSession } from "./chat-session-context";
import { ModelSelect } from "./model-select";

// Session-config slot: binds the presentational ModelSelect to the ChatSession
// context so it can be composed anywhere inside ChatSessionProvider (e.g. the
// composer toolbar).
export function ChatModelSelect() {
  const { model, setModel } = useChatSession();
  return <ModelSelect value={model} onChange={setModel} />;
}
