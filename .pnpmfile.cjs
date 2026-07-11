// The workspace typechecks with TypeScript 7, whose native package no longer ships
// the JavaScript compiler API (`ts.sys`, `ts.createProgram`, …). rolldown-plugin-dts
// (used by tsdown to emit .d.ts files) drives that API for packages whose sources
// aren't isolated-declarations compatible, and crashes at load under TypeScript 7.
//
// A `pnpm.overrides` entry can't fix this because `typescript` is a *peer* of the
// plugin and peer resolution keeps selecting the workspace's TypeScript 7. Instead we
// turn that peer into a real dependency pinned to a TypeScript 5.x that still ships the
// JS API, so declaration emit keeps working. `tsc` typechecking is unaffected — it uses
// each package's own TypeScript 7.
const DTS_TOOL_TYPESCRIPT = "5.9.3";

function readPackage(pkg) {
  if (pkg.name === "rolldown-plugin-dts") {
    if (pkg.peerDependencies && pkg.peerDependencies.typescript) {
      delete pkg.peerDependencies.typescript;
    }
    if (pkg.peerDependenciesMeta && pkg.peerDependenciesMeta.typescript) {
      delete pkg.peerDependenciesMeta.typescript;
    }
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies.typescript = DTS_TOOL_TYPESCRIPT;
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
