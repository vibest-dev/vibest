// What the vibest binary's frontends (the command line, the herdr plugin) use from its own process, besides the client
// and the contracts: the daemon's start, and the product's local steps that need no vibestd (the main agent's exec,
// the harness listing, project creation). The frontends import nothing else of the daemon, the product or the engine
// (apps/vibest/test/layering.test.ts); what they need of the bundled runtime comes from the host (`#platform`).
export * as Daemon from "./daemon.ts"
export * as Launch from "@vibest/vibest/launch"
export * as LocalHarnesses from "@vibest/vibest/harnesses"
export { ProjectKind } from "@vibest/vibest/project"
export { createProject, projectRoot } from "@vibest/vibest/project-create"
