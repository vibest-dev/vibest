import fs from "node:fs";
import module from "node:module";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { claudeCodeTools } from "../../src/claude-code/tools";

// Source-text guard: the executable counterpart of the wire-name map in
// tools.ts. It reads the INSTALLED `sdk-tools.d.ts`, extracts every tool the
// SDK ships (the `ToolInputSchemas` / `ToolOutputSchemas` unions), and asserts
// that each one is accounted for in the registry — either present verbatim,
// renamed to a known wire key, or explicitly excluded with a reason. An SDK
// bump that adds OR removes a tool breaks this test with the exact diff, so the
// registry never silently drifts behind the SDK. (Structural `Exclude` can't do
// this: `RefreshMcpToolsInput` is structurally identical to
// `ListMcpResourcesInput`, so a type-level subtraction would swallow it.)

// SDK type-name → registry wire key, for tools whose wire name differs from the
// sdk-tools.d.ts type name. Verified against the CLI binary's own name map.
const RENAMES: Record<string, string> = {
  FileRead: "Read",
  FileEdit: "Edit",
  FileWrite: "Write",
  ListMcpResources: "ListMcpResourcesTool",
  ReadMcpResource: "ReadMcpResourceTool",
  ReadMcpResourceDir: "ReadMcpResourceDirTool",
  ClaudeDesign: "DesignSync",
  ProposeSkills: "propose_skills",
};

// SDK tool types deliberately kept out of the registry (rendered generically).
const EXCLUDED: Record<string, string> = {
  Mcp: "wire name is per-server mcp__<server>__<tool>; no fixed key exists",
};

// Registry keys with no corresponding SDK tool type (aliases / hand-written).
const NON_SDK_KEYS = new Set(["Task"]); // Task is a registry alias of Agent

function readSdkToolsSource(): string {
  const require = module.createRequire(import.meta.url);
  const main = require.resolve("@anthropic-ai/claude-agent-sdk");
  return fs.readFileSync(path.join(path.dirname(main), "sdk-tools.d.ts"), "utf8");
}

// Base tool names from the two top-level unions. Each union member is a
// `<Name>Input` / `<Name>Output` reference; strip the suffix to get the tool.
function sdkToolNames(source: string): Set<string> {
  const union = (typeName: string, suffix: "Input" | "Output"): string[] => {
    const start = source.indexOf(`export type ${typeName} =`);
    if (start === -1) throw new Error(`union ${typeName} not found in sdk-tools.d.ts`);
    const body = source.slice(start, source.indexOf(";", start));
    return [...body.matchAll(new RegExp(`\\b(\\w+)${suffix}\\b`, "g"))].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
  };
  return new Set([...union("ToolInputSchemas", "Input"), ...union("ToolOutputSchemas", "Output")]);
}

describe("claude-code tool registry ↔ SDK alignment", () => {
  test("every SDK tool is registered, renamed, or explicitly excluded", () => {
    const source = readSdkToolsSource();

    const expected = new Set<string>();
    for (const name of sdkToolNames(source)) {
      if (name in EXCLUDED) continue;
      expected.add(RENAMES[name] ?? name);
    }

    const actual = new Set(Object.keys(claudeCodeTools).filter((k) => !NON_SDK_KEYS.has(k)));

    // One flat list so a failure prints the exact drift: SDK-added tools the
    // registry lacks (register them or add to EXCLUDED), and registry entries
    // the SDK dropped (remove them). Empty when aligned.
    const drift = [
      ...[...expected].filter((k) => !actual.has(k)).map((k) => `missing: ${k}`),
      ...[...actual].filter((k) => !expected.has(k)).map((k) => `extra: ${k}`),
    ];

    expect(drift).toEqual([]);
  });
});
