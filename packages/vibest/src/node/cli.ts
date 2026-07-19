#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";

import pkg from "../../package.json" with { type: "json" };
import { runServe, serve, serveFlags } from "./commands/serve";

// The root command runs `serve` when invoked bare, so `node cli.mjs` (how the
// desktop supervisor spawns it, args-free, config via env) starts the server.
// Subcommands hang off `withSubcommands` — add to the array to grow the CLI.
const vibest = Command.make("vibest", serveFlags, runServe).pipe(
  Command.withDescription("Vibest local server"),
  Command.withSubcommands([serve]),
);

Command.run(vibest, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
);
