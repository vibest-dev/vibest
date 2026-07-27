import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Context, Effect, Layer } from "effect";

import { PathsLayer } from "../config/paths";
import { EventBusLayer } from "../events";
import { FileSystemServiceLayer } from "../fs";
import {
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

export const ClaudeCodeLayer: Layer.Layer<ClaudeCode> = Layer.effect(
  ClaudeCode,
  makeClaudeCodeAgent(),
);

const NodeProcessLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

export const CodexLayer: Layer.Layer<Codex> = Layer.effect(Codex, makeCodexAgent()).pipe(
  Layer.provide(NodeProcessLayer),
);

export const PiLayer: Layer.Layer<Pi> = Layer.effect(Pi, makePiAgent()).pipe(
  Layer.provide(NodeProcessLayer),
);

const ProvidersLayer = Layer.mergeAll(ClaudeCodeLayer, CodexLayer, PiLayer);

const RegistryLayer = Layer.effect(
  HarnessAgentRegistry,
  Effect.gen(function* () {
    const claudeCode = yield* ClaudeCode;
    const codex = yield* Codex;
    const pi = yield* Pi;
    return makeHarnessAgentRegistry([
      makeClaudeCodeAdapter(claudeCode),
      makeCodexAdapter(codex),
      makePiAdapter(pi),
    ]);
  }),
).pipe(Layer.provide(ProvidersLayer));

// Both harness routes read the same registry instance. It matters most for the
// probe: one cache, shared by every connecting client, so N tabs on the same
// directory still cost one CLI spawn.
const HarnessListProvided = HarnessListLayer.pipe(Layer.provide(RegistryLayer));
const HarnessProbeProvided = HarnessProbeLayer.pipe(Layer.provide(RegistryLayer));

// Harness session lifecycle (agent-native ids only); shared by the port and RPC.
const HarnessSessionServiceLayer = HarnessAgentSessionServiceLayer.pipe(
  Layer.provide(RegistryLayer),
);

// Server-owned services. Each shared dependency (EventBus, harness service,
// ProjectService) is a single Layer reference, so Effect memoizes it to one
// instance across every consumer below.
const ProjectServiceProvided = ProjectServiceLayer.pipe(
  Layer.provide(ProjectRepositoryLayer),
  Layer.provide(PathsLayer),
);
const SessionRepositoryProvided = SessionRepositoryLayer.pipe(Layer.provide(PathsLayer));
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
  FileSystemServiceLayer,
  NodeFileSystem.layer,
);
