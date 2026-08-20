// Browser-safe Grok tool schemas and UI-message types. The pure UI
// vocabulary the SPA renders against; server-side transforms import from here
// too. Runtime (ACP stdio, session lifecycle) lives in @vibest/server.
export * from "./tools";
export type { GrokUIMessage, GrokUIMessageChunk, GrokMetadata, GrokDataTypes } from "./ui-message";
