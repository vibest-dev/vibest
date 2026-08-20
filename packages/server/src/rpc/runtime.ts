import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, type FileSystem, Layer } from "effect";

import { PathsLayer } from "../config/paths";
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
import { makeGrokAdapter, makeGrokAgent, type GrokAgent } from "../harness/grok";
import { makePiAdapter, makePiAgent, type PiAgent } from "../harness/pi";
import { ProjectRepositoryLayer, ProjectServiceLayer } from "../project";
import { NodePtySpawnerLayer, PtyManagerLayer, PtyServiceLayer } from "../pty";

export class ClaudeCode extends Context.Service<ClaudeCode, ClaudeCodeAgent>()("ClaudeCode") {}
export class Codex extends Context.Service<Codex, CodexAgent>()("Codex") {}
export class Pi extends Context.Service<Pi, PiAgent>()("Pi") {}
export class Grok extends Context.Service<Grok, GrokAgent>()("Grok") {}

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

export const GrokLayer: Layer.Layer<Grok> = Layer.effect(Grok, makeGrokAgent()).pipe(
  Layer.provide(NodeProcessLayer),
  Layer.provide(PlatformLayer),
);

const ProvidersLayer = Layer.mergeAll(ClaudeCodeLayer, CodexLayer, PiLayer, GrokLayer);

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
    const grok = yield* Grok;
    const adapters = yield* Effect.forEach(
      [
        makeClaudeCodeAdapter(claudeCode),
        makeCodexAdapter(codex),
        makePiAdapter(pi),
        makeGrokAdapter(grok),
      ],
      cacheAvailability,
    );
    return makeHarnessAgentRegistry(adapters);
  }),
).pipe(Layer.provide(ProvidersLayer), Layer.provide(PlatformLayer));

// Both harness routes read the same registry instance. It matters most for the
// probe: one cache, shared by every connecting client, so N tabs on the same
// directory still cost one CLI spawn.
const HarnessListProvided = HarnessListLayer.pipe(
  Layer.provide(RegistryLayer),
  Layer.provide(PlatformLayer),
);
const HarnessProbeProvided = HarnessProbeLayer.pipe(Layer.provide(RegistryLayer));

// The session stack: the manager owns all live state (instances + projections,
// publishing wire events onto the bus); the outward façade on top does the
// identity translation, metadata persistence, and collection events.
// EventBusLayer is ONE const reference everywhere below — Effect memoizes
// layers by reference, so publish (manager/service) and subscribe (RPC) share
// the single bus instance. A second reference (or Layer.fresh) would split the
// bus and silently drop events.
const HarnessSessionManagerProvided = HarnessAgentSessionManagerLayer.pipe(
  Layer.provide(RegistryLayer),
  Layer.provide(EventBusLayer),
  Layer.provide(PlatformLayer),
);
const HarnessSessionServiceProvided = HarnessAgentSessionServiceLayer.pipe(
  Layer.provide(HarnessSessionManagerProvided),
  Layer.provide(RegistryLayer),
  Layer.provide(EventBusLayer),
  Layer.provide(PathsLayer),
  Layer.provide(PlatformLayer),
);

const ProjectServiceProvided = ProjectServiceLayer.pipe(
  Layer.provide(ProjectRepositoryLayer),
  Layer.provide(PathsLayer),
  Layer.provide(PlatformLayer),
);

const PtyManagerProvided = PtyManagerLayer.pipe(
  Layer.provide(NodePtySpawnerLayer),
  Layer.provide(PlatformLayer),
);
const PtyServiceProvided = PtyServiceLayer.pipe(
  Layer.provide(PtyManagerProvided),
  Layer.provide(ProjectServiceProvided),
);

// RegistryLayer is merged in as well as provided into the session stack;
// Effect memoizes it by reference, so both see the one registry instance while
// the harness route can resolve capabilities directly off it.
export const AgentRuntimeLayer = Layer.mergeAll(
  EventBusLayer,
  HarnessSessionServiceProvided,
  ProjectServiceProvided,
  RegistryLayer,
  HarnessListProvided,
  HarnessProbeProvided,
  FileSystemServiceLayer.pipe(Layer.provide(PlatformLayer)),
  PtyServiceProvided,
  PlatformLayer,
  // For the HTTP request app: `HttpStaticServer` needs it to turn a file into a
  // response. Sealed by the vendor layer, hence no `Layer.provide` here.
  NodeHttpPlatform.layer,
);
