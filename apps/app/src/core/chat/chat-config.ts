// Session config the user picks (model + permission mode) and that travels with
// each prompt. Lives here — not in the transport — so the transport and the UI
// both depend on it, rather than the UI reaching down into the transport layer.
export type ChatModel = "opus" | "sonnet";
// An outward permission-mode id from the session's harness capabilities
// (e.g. claude-code's "plan" / "ask" / "acceptEdits" / "full").
export type ChatPermissionMode = string;
