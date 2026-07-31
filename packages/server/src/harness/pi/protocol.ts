import type {
  AgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

// Pi's RPC wire protocol (`pi --mode rpc`, JSON lines over stdio). Unlike codex,
// the types come straight from the published package — pi is TypeScript-native,
// so there is no vendored ts-rs output. All imports are type-only; the pi
// runtime itself never loads in-process.
//
// stdout frames:
//   • `{ type: "response", command, success, ... }`  — reply to a stdin command
//   • `{ type: "extension_ui_request", ... }`        — extension UI sub-protocol
//   • everything else                                 — an AgentSessionEvent
export type {
  AgentSessionEvent,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
  SessionEntry,
  SessionMessageEntry,
};

/** `get_entries` response data: the session's whole entry tree plus its leaf. */
export type SessionEntries = {
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly leafId: string | null;
};

/**
 * The extension-UI methods that block the agent until the host replies with an
 * `extension_ui_response`. The rest (notify/setStatus/setWidget/…) are
 * fire-and-forget display hints.
 */
export type PiUiRequest = Extract<
  RpcExtensionUIRequest,
  { method: "confirm" | "select" | "input" | "editor" }
>;

const BLOCKING_UI_METHODS = new Set(["confirm", "select", "input", "editor"]);

export function isBlockingUiRequest(request: RpcExtensionUIRequest): request is PiUiRequest {
  return BLOCKING_UI_METHODS.has(request.method);
}
