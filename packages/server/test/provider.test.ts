import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  layerPaths,
  type ProviderConfig,
  ProviderService,
  ProviderServiceLayer,
  ProviderRepositoryLayer,
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

  it("resolves a ModelSelection to a ResolvedModelConfig", async () => {
    const resolved = await run(
      Effect.gen(function* () {
        const svc = yield* ProviderService;
        yield* svc.configure({ ...openai, baseURL: "https://api.example.com" });
        return yield* svc.resolve({ providerId: "openai", modelId: "gpt-5" });
      }),
    );
    expect(resolved).toEqual({
      model: "gpt-5",
      provider: "openai",
      baseURL: "https://api.example.com",
      authToken: "sk-test",
    });
  });

  it("fails resolve with ProviderNotFound for unknown provider", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const svc = yield* ProviderService;
          return yield* svc.resolve({ providerId: "ghost", modelId: "x" });
        }),
      ),
    );
    expect(err._tag).toBe("ProviderNotFound");
  });

  it("fails resolve with ModelSelectionUnresolvable when provider disabled", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const svc = yield* ProviderService;
          yield* svc.configure({ ...openai, enabled: false });
          return yield* svc.resolve({ providerId: "openai", modelId: "gpt-5" });
        }),
      ),
    );
    expect(err._tag).toBe("ModelSelectionUnresolvable");
  });
});
