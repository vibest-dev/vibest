#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import pkg from "../../package.json" with { type: "json" };
import { runServe, serveFlags } from "./serve";

// The forkable server entry (`dist/server.mjs`). The desktop supervisor and the
// local daemon launcher spawn this args-free with config in the environment; it
// runs the same foreground `serve` body the `vibest serve` CLI command does.
const server = Command.make("vibest-server", serveFlags, runServe).pipe(
  Command.withDescription("Vibest server"),
);

Command.run(server, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
);
