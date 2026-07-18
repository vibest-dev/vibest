import { useChatSession } from "./chat-session-context";
import { PermissionModeSelect } from "./permission-mode-select";

// Session-config slot: binds the presentational PermissionModeSelect to the
// ChatSession context so it can be composed anywhere inside
// ChatSessionProvider (e.g. the composer toolbar).
export function ChatPermissionModeSelect() {
  const { agentProviderId, permissionMode, setPermissionMode } = useChatSession();
  return (
    <PermissionModeSelect
      harnessAgentId={agentProviderId}
      value={permissionMode}
      onChange={setPermissionMode}
    />
  );
}
