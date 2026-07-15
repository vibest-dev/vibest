import { describe, expect, it } from "@effect/vitest";
import { eventIterator, oc } from "@orpc/contract";
import { tool } from "ai";
import { Schema } from "effect";
import { z } from "zod";

import { toStandardSchema } from "../../src/schema/standard";

const GreetingInput = Schema.Struct({
  name: Schema.String,
});

const GreetingInputStandard = toStandardSchema(GreetingInput);

describe("toStandardSchema", () => {
  it("exposes validation and JSON Schema to oRPC and AI SDK", async () => {
    const validation = await GreetingInputStandard["~standard"].validate({ name: "Ada" });

    expect("issues" in validation).toBe(false);
    expect(typeof GreetingInputStandard["~standard"].jsonSchema?.input).toBe("function");

    const procedure = oc.input(GreetingInputStandard);
    const aiTool = tool({
      description: "Greet a person",
      inputSchema: GreetingInputStandard,
      execute: async ({ name }) => `Hello, ${name}`,
    });

    expect(procedure["~orpc"].inputSchemas).toContain(GreetingInputStandard);
    expect(aiTool.inputSchema).toBe(GreetingInputStandard);
  });

  it("coexists with Zod and supports event iterator yield schemas", () => {
    const router = {
      effect: oc.input(GreetingInputStandard),
      zod: oc.input(z.object({ id: z.string() })),
      events: oc.output(eventIterator(GreetingInputStandard)),
    };

    expect(router.effect["~orpc"].inputSchemas).toContain(GreetingInputStandard);
    expect(router.zod["~orpc"].inputSchemas).toHaveLength(1);
    expect(router.events["~orpc"].outputSchemas).toHaveLength(1);
  });

  it("returns Standard Schema issues for invalid input", async () => {
    const validation = await GreetingInputStandard["~standard"].validate({ name: 42 });

    expect("issues" in validation).toBe(true);
  });
});
