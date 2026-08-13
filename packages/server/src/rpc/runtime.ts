import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, type Crypto, Effect, type FileSystem, Layer } from "effect";

import { type Paths, PathsLayer } from "../config/paths";
import { EventBusLayer } from "../events";
import { FileSystemServiceLayer } from "../fs";
import {
  type HarnessAgentAdapter,
  HarnessAgentRegistry,
  HarnessAgentSessionManagerLayer,
  HarnessAgentSessionServiceLayer,
  HarnessListLayer,
  HarnessProbeLayer,
  makeHarnessAgentRegistry,
} from "../harness";
import {
  makeClaudeCodeAdapter,
  makeClaudeCodeAgent,
  type ClaudeCodeAgent,
} from "../harness/claude-code";
import { makeCodexAdapter, makeCodexAgent, type CodexAgent } from "../harness/codex";
import { makePiAdapter, makePiAgent, type PiAgent } from "../harness/pi";
import { ProjectModuleLayer } from "../project";

export class ClaudeCode extends Context.Service<ClaudeCode, ClaudeCodeAgent>()("ClaudeCode") {}
export class Codex extends Context.Service<Codex, CodexAgent>()("Codex") {}
export class Pi extends Context.Service<Pi, PiAgent>()("Pi") {}

/**
 * The Node platform services. Every effect that touches disk, paths, or random
 * bytes bubbles these up its `R` channel; this is the one place they are
 * satisfied for the server runtime.
 */
const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);

const NodeProcessLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(PlatformLayer));

export const ClaudeCodeLayer: Layer.Layer<ClaudeCode> = Layer.effect(
  ClaudeCode,
  makeClaudeCodeAgent(),
).pipe(Layer.provide(PlatformLayer));

export const CodexLayer: Layer.Layer<Codex> = Layer.effect(Codex, makeCodexAgent()).pipe(
  Layer.provide(NodeProcessLayer),
);

export const PiLayer: Layer.Layer<Pi> = Layer.effect(Pi, makePiAgent()).pipe(
  Layer.provide(NodeProcessLayer),
);

const ProvidersLayer = Layer.mergeAll(ClaudeCodeLayer, CodexLayer, PiLayer);

/**
 * Which CLI is installed, and whether it is new enough, is fixed for the life
 * of the process — but `harness.list` is awaited before first paint and every
 * `session.create` asks again, and claude-code's check spawns `claude
 * --version` (~45ms) each time. Cache it here, at the one place that builds the
 * registry, so the answer costs one spawn per server rather than one per call.
 *
 * The trade is that a CLI installed while the server is running is not noticed
 * until it restarts.
 */
// The `uninterruptible` around the CALL is load-bearing: `Effect.cached` runs
// the computation on the first caller's fiber and stores whatever exit it
// observes — forever, including an interruption. A client that disconnects
// mid-`harness.list` interrupts that fiber, and the poisoned cache then
// replays the interruption to every later caller: the endpoint 500s until the
// server restarts. Wrapping the computation alone is not enough (the pending
// interrupt lands exactly when interruptibility is restored, before the cache
// stores the exit), so the guard covers the whole cached call. The check is
// bounded (one `--version` spawn with its own timeout), so riding out the
// interruption is safe.
export const cacheAvailability = (
  adapter: HarnessAgentAdapter,
): Effect.Effect<HarnessAgentAdapter, never, FileSystem.FileSystem> =>
  Effect.map(Effect.cached(adapter.checkAvailability), (cachedCheck) => ({
    ...adapter,
    checkAvailability: Effect.uninterruptible(cachedCheck),
  }));

const RegistryLayer = Layer.effect(
  HarnessAgentRegistry,
  Effect.gen(function* () {
    const claudeCode = yield* ClaudeCode;
    const codex = yield* Codex;
    const pi = yield* Pi;
    const adapters = yield* Effect.forEach(
      [makeClaudeCodeAdapter(claudeCode), makeCodexAdapter(codex), makePiAdapter(pi)],
      cacheAvailability,
    );
    return makeHarnessAgentRegistry(adapters);
  }),
).pipe(Layer.provide(ProvidersLayer), Layer.provide(PlatformLayer));

/** What the shared composition needs from the host platform. */
export type AgentRuntimePlatform = Crypto.Crypto | FileSystem.FileSystem;

/**
 * The one composition shape for the agent runtime — production and the test
 * harnesses both build through here, so a wiring regression fails in tests
 * before it ships.
 *
 * Layer equivalence is not instance identity: Effect memoizes layers by
 * *reference*, so a structurally identical Layer value built elsewhere is a
 * second instance. The stateful shared services each stay a single value
 * inside this function — `EventBusLayer` (publish in the manager/service,
 * subscribe in RPC), `options.registry` (list, probe, and the session stack
 * share one availability cache), and the session manager (sole owner of live
 * state). Reconstructing any of them inline — or wrapping one in
 * `Layer.fresh` — would silently split that state; the behavioural tests in
 * `test/runtime-composition.test.ts` are the regression gate.
 *
 * Stateless layers (platform, adapters) carry no such constraint and may be
 * built independently where sharing is not required.
 */
export const makeAgentRuntimeLayer = (options: {
  /** Fully provided — the single registry instance every consumer shares. */
  readonly registry: Layer.Layer<HarnessAgentRegistry>;
  readonly paths: Layer.Layer<Paths>;
  readonly platform: Layer.Layer<AgentRuntimePlatform>;
}) => {
  const { registry, paths, platform } = options;

  // The session stack: the manager owns all live state (instances +
  // projections, publishing wire events onto the bus); the outward façade on
  // top does the identity translation, metadata persistence, and collection
  // events.
  const sessionManager = HarnessAgentSessionManagerLayer.pipe(
    Layer.provide(registry),
    Layer.provide(EventBusLayer),
    Layer.provide(platform),
  );
  const sessionService = HarnessAgentSessionServiceLayer.pipe(
    Layer.provide(sessionManager),
    Layer.provide(registry),
    Layer.provide(EventBusLayer),
    Layer.provide(paths),
    Layer.provide(platform),
  );

  // Both harness routes read the same registry instance. It matters most for
  // the probe: one cache, shared by every connecting client, so N tabs on the
  // same directory still cost one CLI spawn.
  const list = HarnessListLayer.pipe(Layer.provide(registry), Layer.provide(platform));
  const probe = HarnessProbeLayer.pipe(Layer.provide(registry));

  const project = ProjectModuleLayer.pipe(Layer.provide(paths), Layer.provide(platform));

  // The registry is merged in as well as provided into the stacks above;
  // memoization by reference means every consumer sees the one instance while
  // the harness route can resolve capabilities directly off it.
  return Layer.mergeAll(
    EventBusLayer,
    sessionService,
    project,
    registry,
    list,
    probe,
    FileSystemServiceLayer.pipe(Layer.provide(platform)),
    platform,
  );
};

export const AgentRuntimeLayer = Layer.mergeAll(
  makeAgentRuntimeLayer({
    registry: RegistryLayer,
    paths: PathsLayer,
    platform: PlatformLayer,
  }),
  // `Path` for `HttpStaticServer` — same PlatformLayer reference as above, so
  // merging it here widens the context without a second build.
  PlatformLayer,
  // For the HTTP request app: `HttpStaticServer` needs it to turn a file into a
  // response. Sealed by the vendor layer, hence no `Layer.provide` here.
  NodeHttpPlatform.layer,
);
