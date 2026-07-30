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
import { ProjectRepositoryLayer, ProjectServiceLayer } from "../project";
import {
  HarnessAgentSessionPortLayer,
  SessionManagerLayer,
  SessionRepositoryLayer,
  SessionServiceLayer,
} from "../session";

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
const cacheAvailability = (
  adapter: HarnessAgentAdapter,
): Effect.Effect<HarnessAgentAdapter, never, FileSystem.FileSystem> =>
  Effect.map(Effect.cached(adapter.checkAvailability), (checkAvailability) => ({
    ...adapter,
    checkAvailability,
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

// Both harness routes read the same registry instance. It matters most for the
// probe: one cache, shared by every connecting client, so N tabs on the same
// directory still cost one CLI spawn.
const HarnessListProvided = HarnessListLayer.pipe(
  Layer.provide(RegistryLayer),
  Layer.provide(PlatformLayer),
);
const HarnessProbeProvided = HarnessProbeLayer.pipe(Layer.provide(RegistryLayer));

// Harness session lifecycle (agent-native ids only); shared by the port and RPC.
const HarnessSessionServiceLayer = HarnessAgentSessionServiceLayer.pipe(
  Layer.provide(RegistryLayer),
  Layer.provide(PlatformLayer),
);

// Server-owned services. Each shared dependency (EventBus, harness service,
// ProjectService) is a single Layer reference, so Effect memoizes it to one
// instance across every consumer below.
const ProjectServiceProvided = ProjectServiceLayer.pipe(
  Layer.provide(ProjectRepositoryLayer),
  Layer.provide(PathsLayer),
  Layer.provide(PlatformLayer),
);
const SessionRepositoryProvided = SessionRepositoryLayer.pipe(
  Layer.provide(PathsLayer),
  Layer.provide(PlatformLayer),
);
const HarnessAgentSessionPortProvided = HarnessAgentSessionPortLayer.pipe(
  Layer.provide(HarnessSessionServiceLayer),
);
// The manager and the bus are internal collaborators of SessionService now, so
// the façade composes them here. EventBusLayer is one reference, so publish
// (SessionService), fan-out (SessionManager), and subscribe (RPC) share it.
const SessionManagerProvided = SessionManagerLayer.pipe(Layer.provide(EventBusLayer));
const SessionServiceProvided = SessionServiceLayer.pipe(
  Layer.provide(ProjectServiceProvided),
  Layer.provide(SessionRepositoryProvided),
  Layer.provide(HarnessAgentSessionPortProvided),
  Layer.provide(SessionManagerProvided),
  Layer.provide(EventBusLayer),
  Layer.provide(PlatformLayer),
);

// RegistryLayer is merged in as well as provided into SessionServiceLayer;
// Effect memoizes it by reference, so both see the one registry instance while
// the harness route can resolve capabilities directly off it.
export const AgentRuntimeLayer = Layer.mergeAll(
  EventBusLayer,
  SessionServiceProvided,
  ProjectServiceProvided,
  RegistryLayer,
  HarnessListProvided,
  HarnessProbeProvided,
  FileSystemServiceLayer.pipe(Layer.provide(PlatformLayer)),
  PlatformLayer,
  // For the HTTP request app: `HttpStaticServer` needs it to turn a file into a
  // response. Sealed by the vendor layer, hence no `Layer.provide` here.
  NodeHttpPlatform.layer,
);
