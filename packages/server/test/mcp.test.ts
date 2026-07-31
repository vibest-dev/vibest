import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer } from "effect";

import {
  layerPaths,
  type McpServerConfig,
  McpRepositoryLayer,
  McpService,
  McpServiceLayer,
  ProviderRepository,
  ProviderRepositoryLayer,
} from "../src/index";
import { NodePlatformLayer } from "./platform";

const stdioServer: McpServerConfig = {
  id: "fs",
  transport: "stdio",
  command: "mcp-fs",
  args: ["--root", "/tmp"],
};

layer(NodePlatformLayer)("McpService", (it) => {
  /** Both services over one fresh `$VIBEST_HOME`, so they share its config.json. */
  const services = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "vibest-mcp-" });
    const paths = Layer.provideMerge(layerPaths(home), NodePlatformLayer);
    const context = yield* Layer.build(
      Layer.mergeAll(
        ProviderRepositoryLayer.pipe(Layer.provide(paths)),
        McpServiceLayer.pipe(Layer.provide(McpRepositoryLayer.pipe(Layer.provide(paths)))),
      ),
    );
    return {
      mcp: Context.get(context, McpService),
      providers: Context.get(context, ProviderRepository),
    };
  });

  it.effect("creates and lists an MCP server", () =>
    Effect.gen(function* () {
      const { mcp } = yield* services;
      yield* mcp.create(stdioServer);

      const list = yield* mcp.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, "fs");
    }),
  );

  it.effect("enable/disable toggles enabledFor", () =>
    Effect.gen(function* () {
      const { mcp } = yield* services;
      yield* mcp.create(stdioServer);

      yield* mcp.enable("fs", "claude-code");
      yield* mcp.enable("fs", "claude-code"); // idempotent
      assert.deepEqual((yield* mcp.list())[0]?.enabledFor ?? [], ["claude-code"]);

      yield* mcp.disable("fs", "claude-code");
      assert.deepEqual((yield* mcp.list())[0]?.enabledFor ?? [], []);
    }),
  );

  it.effect("enable fails with McpServerNotFound for unknown id", () =>
    Effect.gen(function* () {
      const { mcp } = yield* services;
      const error = yield* Effect.flip(mcp.enable("ghost", "codex"));
      assert.equal(error._tag, "McpServerNotFound");
    }),
  );

  it.effect("writing mcp does not clobber the provider field in config.json", () =>
    Effect.gen(function* () {
      const { mcp, providers } = yield* services;
      yield* providers.save([{ id: "openai", enabled: true }]);
      yield* mcp.create(stdioServer); // rewrites config.json

      const list = yield* providers.list();
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, "openai");
    }),
  );
});
