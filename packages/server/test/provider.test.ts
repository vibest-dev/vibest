import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer } from "effect";

import {
  layerPaths,
  type ProviderConfig,
  ProviderRepositoryLayer,
  ProviderService,
  ProviderServiceLayer,
} from "../src/index";
import { NodePlatformLayer } from "./platform";

const openai: ProviderConfig = {
  id: "openai",
  enabled: true,
  apiKey: "sk-test",
  models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
};

layer(NodePlatformLayer)("ProviderService", (it) => {
  /**
   * A service over its own `$VIBEST_HOME`. Built inside the test, so each one
   * gets a fresh instance and a fresh temp dir, and the test's scope removes
   * both — no `beforeEach`, no mutable `home` for a wrapper to close over.
   */
  const providers = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-prov-" });
    const context = yield* Layer.build(
      ProviderServiceLayer.pipe(
        Layer.provide(ProviderRepositoryLayer),
        Layer.provide(layerPaths(home)),
        Layer.provide(NodePlatformLayer),
      ),
    );
    return Context.get(context, ProviderService);
  });

  it.effect("configures (upsert) and lists providers", () =>
    Effect.gen(function* () {
      const svc = yield* providers;
      yield* svc.configure(openai);
      yield* svc.configure({ ...openai, apiKey: "sk-updated" });

      const list = yield* svc.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.apiKey, "sk-updated");
    }),
  );

  it.effect("lists models across / within providers", () =>
    Effect.gen(function* () {
      const svc = yield* providers;
      yield* svc.configure(openai);

      assert.equal((yield* svc.listModels()).length, 2);
      assert.equal((yield* svc.listModels("openai")).length, 2);
    }),
  );
});
