import { useChatSession } from "./chat-session-context";
import { PermissionModeSelect } from "./permission-mode-select";

// Session-config slot: binds the presentational PermissionModeSelect to the
// ChatSession context so it can be composed anywhere inside
// ChatSessionProvider (e.g. the composer toolbar). Renders nothing when the
// harness has no permission protocol.
export function ChatPermissionModeSelect() {
  const { permissionModes, permissionMode, setPermissionMode } = useChatSession();
  return (
    <PermissionModeSelect
      permissionModes={permissionModes}
      value={permissionMode}
      onChange={setPermissionMode}
    />
  );
}
