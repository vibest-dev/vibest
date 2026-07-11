import { Context, Effect, Layer } from "effect";

import type { HarnessAgentId, McpServerConfig } from "../types";

import { McpServerNotFound, type StoreReadError, type StoreWriteError } from "../errors";
import { McpRepository } from "./repository";

/**
 * `mcp` module: register MCP server configs and toggle which harness agents
 * they're enabled for.
 *
 * NOTE: `enable`/`disable` currently only update our own registration
 * (`enabledFor`). Translating a config into each backend's native format
 * (claude-code `.mcp.json`, codex `config.toml`) is the adapter's
 * `IMcpConfigWriter` job and is not implemented yet (see design §4.10 / §8).
 */
export class McpService extends Context.Service<
  McpService,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<McpServerConfig>, StoreReadError>;
    readonly create: (
      server: McpServerConfig,
    ) => Effect.Effect<McpServerConfig, StoreReadError | StoreWriteError>;
    readonly enable: (
      serverId: string,
      harnessAgentId: HarnessAgentId,
    ) => Effect.Effect<void, StoreReadError | StoreWriteError | McpServerNotFound>;
    readonly disable: (
      serverId: string,
      harnessAgentId: HarnessAgentId,
    ) => Effect.Effect<void, StoreReadError | StoreWriteError | McpServerNotFound>;
  }
>()("McpService") {}

const withEnabledFor = (
  server: McpServerConfig,
  enabledFor: ReadonlyArray<HarnessAgentId>,
): McpServerConfig => ({ ...server, enabledFor });

export const McpServiceLayer: Layer.Layer<McpService, never, McpRepository> = Layer.effect(
  McpService,
  Effect.gen(function* () {
    const repo = yield* McpRepository;

    const update = (
      serverId: string,
      f: (current: ReadonlyArray<HarnessAgentId>) => ReadonlyArray<HarnessAgentId>,
    ) =>
      Effect.gen(function* () {
        const servers = yield* repo.list();
        const target = servers.find((s) => s.id === serverId);
        if (target === undefined) {
          return yield* Effect.fail(new McpServerNotFound({ serverId }));
        }
        const updated = withEnabledFor(target, f(target.enabledFor ?? []));
        yield* repo.save(servers.map((s) => (s.id === serverId ? updated : s)));
      });

    return {
      list: () => repo.list(),

      create: (server) =>
        Effect.gen(function* () {
          const servers = yield* repo.list();
          const exists = servers.some((s) => s.id === server.id);
          const next = exists
            ? servers.map((s) => (s.id === server.id ? server : s))
            : [...servers, server];
          yield* repo.save(next);
          return server;
        }),

      enable: (serverId, harnessAgentId) =>
        update(serverId, (current) =>
          current.includes(harnessAgentId) ? current : [...current, harnessAgentId],
        ),

      disable: (serverId, harnessAgentId) =>
        update(serverId, (current) => current.filter((id) => id !== harnessAgentId)),
    };
  }),
);
