import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  makeClaudeCodeAdapter,
  makeClaudeCodeAgent,
  type ClaudeCodeAgent,
} from "@vibest/harness/claude-code";
import { makeCodexAdapter, makeCodexAgent, type CodexAgent } from "@vibest/harness/codex";
import { makePiAdapter, makePiAgent, type PiAgent } from "@vibest/harness/pi";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionServiceLayer,
  makeHarnessAgentRegistry,
} from "@vibest/harness/runtime";
import { Context, Effect, Layer } from "effect";

import { PathsLayer } from "../config/paths";
import { EventBusLayer } from "../events";
import { FileSystemServiceLayer } from "../fs";
import { ProjectModuleLayer } from "../project";
import { SessionRepositoryLayer } from "../session";

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

const SessionServiceLayer = HarnessAgentSessionServiceLayer.pipe(
  Layer.provide(RegistryLayer),
  Layer.provide(EventBusLayer),
);

export const AgentRuntimeLayer = Layer.mergeAll(
  EventBusLayer,
  SessionServiceLayer,
  FileSystemServiceLayer,
  ProjectModuleLayer.pipe(Layer.provide(PathsLayer)),
  SessionRepositoryLayer.pipe(Layer.provide(PathsLayer)),
  NodeFileSystem.layer,
);
