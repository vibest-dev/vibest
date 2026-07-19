import type { ToolStateCompleted } from "@opencode-ai/sdk";
import { describe, expectTypeOf, test } from "vitest";

import { isDynamicOpencodeTool, type OpencodeTools } from "../../src/opencode/tools";
import type { OpencodeUIMessageChunk } from "../../src/opencode/ui-message";

type In<K extends keyof OpencodeTools> = OpencodeTools[K]["input"];
type Out<K extends keyof OpencodeTools> = OpencodeTools[K]["output"];

describe("opencode tools mirror the v1.18.3 built-in registry", () => {
  test("registry keys are exactly the stable built-in wire ids", () => {
    expectTypeOf<keyof OpencodeTools>().toEqualTypeOf<
      | "bash"
      | "read"
      | "edit"
      | "write"
      | "glob"
      | "grep"
      | "task"
      | "todowrite"
      | "webfetch"
      | "websearch"
      | "apply_patch"
      | "question"
      | "skill"
      | "invalid"
    >();
  });

  test("inputs transcribe the upstream parameter schemas", () => {
    expectTypeOf<In<"bash">>().toEqualTypeOf<{
      command: string;
      timeout?: number;
      workdir?: string;
    }>();
    expectTypeOf<In<"read">>().toEqualTypeOf<{
      filePath: string;
      offset?: number;
      limit?: number;
    }>();
    expectTypeOf<In<"edit">>().toEqualTypeOf<{
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>();
    expectTypeOf<In<"write">>().toEqualTypeOf<{ content: string; filePath: string }>();
    expectTypeOf<In<"apply_patch">>().toEqualTypeOf<{ patchText: string }>();
  });

  test("outputs anchor to the SDK's ToolStateCompleted", () => {
    expectTypeOf<Out<"glob">>().toExtend<Omit<ToolStateCompleted, "metadata">>();
    expectTypeOf<Out<"glob">["metadata"]>().toEqualTypeOf<{ count: number; truncated: boolean }>();
    expectTypeOf<Out<"grep">["metadata"]>().toEqualTypeOf<{
      matches: number;
      truncated: boolean;
    }>();
    expectTypeOf<Out<"bash">["metadata"]>().toEqualTypeOf<{
      output: string;
      exit: number | null;
      truncated: boolean;
      outputPath?: string;
    }>();
    expectTypeOf<Out<"websearch">["metadata"]>().toEqualTypeOf<{
      provider: "exa" | "parallel";
    }>();
  });

  test("chunk union: native tracks only, no data-* parts yet", () => {
    type ChunkTypes = OpencodeUIMessageChunk["type"];
    expectTypeOf<"file">().toExtend<ChunkTypes>();
    expectTypeOf<"start-step">().toExtend<ChunkTypes>();
    expectTypeOf<"finish-step">().toExtend<ChunkTypes>();
    expectTypeOf<Extract<ChunkTypes, `data-${string}`>>().toEqualTypeOf<never>();
  });
});

describe("isDynamicOpencodeTool", () => {
  test("built-ins are typed, everything else is dynamic", () => {
    expectTypeOf(isDynamicOpencodeTool).returns.toEqualTypeOf<boolean>();
  });
});
