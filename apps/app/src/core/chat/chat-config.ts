import type { PermissionMode } from "@vibest/contract";

// Session config the user picks (model + permission mode) and that travels with
// each prompt. Lives here — not in the transport — so the transport and the UI
// both depend on it, rather than the UI reaching down into the transport layer.
export type ChatModel = "opus" | "sonnet";
export type ChatPermissionMode = PermissionMode;
