import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  layerPaths,
  type McpServerConfig,
  McpRepositoryLayer,
  McpService,
  McpServiceLayer,
  ProviderRepository,
  ProviderRepositoryLayer,
} from "../src/index";

const stdioServer: McpServerConfig = {
  id: "fs",
  transport: "stdio",
  command: "mcp-fs",
  args: ["--root", "/tmp"],
};

const makeLayer = (home: string) => {
  const paths = layerPaths(home);
  const mcpRepo = McpRepositoryLayer.pipe(Layer.provide(paths));
  const provRepo = ProviderRepositoryLayer.pipe(Layer.provide(paths));
  return Layer.mergeAll(provRepo, McpServiceLayer.pipe(Layer.provide(mcpRepo)));
};

describe("McpService", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vibest-mcp-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const run = <A, E>(program: Effect.Effect<A, E, McpService | ProviderRepository>) =>
    Effect.runPromise(Effect.provide(program, makeLayer(home)));

  it("creates and lists an MCP server", async () => {
    const list = await run(
      Effect.gen(function* () {
        const svc = yield* McpService;
        yield* svc.create(stdioServer);
        return yield* svc.list();
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("fs");
  });

  it("enable/disable toggles enabledFor", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* McpService;
        yield* svc.create(stdioServer);
        yield* svc.enable("fs", "claude-code");
        yield* svc.enable("fs", "claude-code"); // idempotent
        const afterEnable = yield* svc.list();
        yield* svc.disable("fs", "claude-code");
        const afterDisable = yield* svc.list();
        return {
          enabled: afterEnable[0]?.enabledFor ?? [],
          disabled: afterDisable[0]?.enabledFor ?? [],
        };
      }),
    );
    expect(result.enabled).toEqual(["claude-code"]);
    expect(result.disabled).toEqual([]);
  });

  it("enable fails with McpServerNotFound for unknown id", async () => {
    const err = await run(
      Effect.flip(
        Effect.gen(function* () {
          const svc = yield* McpService;
          return yield* svc.enable("ghost", "codex");
        }),
      ),
    );
    expect(err._tag).toBe("McpServerNotFound");
  });

  it("writing mcp does not clobber the provider field in config.json", async () => {
    const providers = await run(
      Effect.gen(function* () {
        const provRepo = yield* ProviderRepository;
        yield* provRepo.save([{ id: "openai", enabled: true }]);
        const svc = yield* McpService;
        yield* svc.create(stdioServer); // rewrites config.json
        return yield* provRepo.list();
      }),
    );
    expect(providers).toHaveLength(1);
    expect(providers[0]?.id).toBe("openai");
  });
});
