import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  layerPaths,
  type ProviderConfig,
  ProviderRepositoryLayer,
  ProviderService,
  ProviderServiceLayer,
} from "../src/index";

const makeLayer = (home: string) =>
  ProviderServiceLayer.pipe(
    Layer.provide(ProviderRepositoryLayer),
    Layer.provide(layerPaths(home)),
  );

const openai: ProviderConfig = {
  id: "openai",
  enabled: true,
  apiKey: "sk-test",
  models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
};

describe("ProviderService", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vibest-prov-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, ProviderService>) =>
    Effect.runPromise(Effect.provide(program, makeLayer(home)));

  it("configures (upsert) and lists providers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* ProviderService;
        yield* svc.configure(openai);
        yield* svc.configure({ ...openai, apiKey: "sk-updated" });
        return yield* svc.list();
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.apiKey).toBe("sk-updated");
  });

  it("lists models across / within providers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* ProviderService;
        yield* svc.configure(openai);
        const all = yield* svc.listModels();
        const scoped = yield* svc.listModels("openai");
        return { all: all.length, scoped: scoped.length };
      }),
    );
    expect(result.all).toBe(2);
    expect(result.scoped).toBe(2);
  });
});
