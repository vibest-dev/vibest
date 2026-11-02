// Web-standard globals every target runtime provides (Bun, Node, Deno). Only the core typecheck sees this file;
// it compiles without any runtime's own types, so a runtime-specific global in src/ fails to typecheck.
declare var TextEncoder: { new (): { encode(input?: string): Uint8Array } }
declare function structuredClone<T>(value: T): T
declare var URL: { new (url: string): { readonly protocol: string; readonly hostname: string; readonly pathname: string } }
