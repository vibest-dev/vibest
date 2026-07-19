#!/usr/bin/env node

import { homedir } from "node:os";
import path from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveOrSpawnDaemon, statusDaemon, stopDaemon } from "@vibest/server/daemon";
import { serve, serveFlags } from "@vibest/server/http";
import { Effect, Option } from "effect";
import { Command } from "effect/unstable/cli";

import pkg from "../../package.json" with { type: "json" };

/** `$VIBEST_HOME`, falling back to `~/.vibest` — matches the server's Paths. */
function vibestHome(): string {
  return process.env.VIBEST_HOME ?? path.join(homedir(), ".vibest");
}

/**
 * argv that re-launches this very CLI in foreground `serve` mode. The daemon is
 * just `vibest serve` spawned detached — no second bundle, and `execArgv`
 * carries the dev loader (e.g. tsx) so it works from source too.
 */
function serverArgv(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? "", "serve"];
}

type DaemonStartInput = {
  readonly port: Option.Option<number>;
  readonly corsOrigin: ReadonlyArray<string>;
};

// Default startup is the daemon: a short-lived `vibest` command must operate a
// backend that outlives it, so it attaches to the running daemon or spawns one.
const startDaemon = (input: DaemonStartInput) =>
  Effect.gen(function* () {
    const handle = yield* Effect.promise(() =>
      resolveOrSpawnDaemon({
        home: vibestHome(),
        serverArgv: serverArgv(),
        port: Option.getOrUndefined(input.port),
        corsOrigins: input.corsOrigin,
      }),
    );
    console.log(
      handle.reused
        ? `vibest daemon already running at ${handle.address} (pid ${handle.pid})`
        : `vibest daemon started at ${handle.address} (pid ${handle.pid})`,
    );
  });

const stopHandler = () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => stopDaemon(vibestHome()));
    console.log(result === "stopped" ? "vibest daemon stopped" : "vibest daemon is not running");
  });

const statusHandler = () =>
  Effect.gen(function* () {
    const status = yield* Effect.promise(() => statusDaemon(vibestHome()));
    if (!status.running || status.record === undefined) {
      console.log("vibest daemon is not running");
      return;
    }
    console.log(`vibest daemon running at ${status.record.address} (pid ${status.record.pid})`);
  });

const daemonStart = Command.make("start", serveFlags, startDaemon).pipe(
  Command.withDescription("Start the vibest daemon, or attach if one is already running"),
);
const daemonStop = Command.make("stop", {}, stopHandler).pipe(
  Command.withDescription("Stop the running vibest daemon"),
);
const daemonStatus = Command.make("status", {}, statusHandler).pipe(
  Command.withDescription("Report whether the vibest daemon is running"),
);

const daemon = Command.make("daemon", serveFlags, startDaemon).pipe(
  Command.withDescription("Manage the vibest daemon (bare `daemon` starts it)"),
  Command.withSubcommands([daemonStart, daemonStop, daemonStatus]),
);

// `vibest serve` stays the plain foreground server — the launcher spawns it
// detached, and process managers / containers / the SSH runner use it directly.
// Bare `vibest` defaults to daemon startup.
const vibest = Command.make("vibest", serveFlags, startDaemon).pipe(
  Command.withDescription("Vibest local server"),
  Command.withSubcommands([serve, daemon]),
);

Command.run(vibest, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  NodeRuntime.runMain,
);
