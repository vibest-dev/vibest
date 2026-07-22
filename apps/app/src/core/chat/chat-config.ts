// Session config the user picks (model + permission mode) and that travels with
// each prompt. Lives here — not in the transport — so the transport and the UI
// both depend on it, rather than the UI reaching down into the transport layer.
//
// Both are opaque ids from the session harness's negotiated capabilities
// (claude-code's "sonnet" / "full", codex's "gpt-5.6-sol" / "ask"). They can't
// be a union of literals: the model catalog is probed at runtime and follows
// the user's account and installed CLI.
export type ChatModel = string;
export type ChatPermissionMode = string;
