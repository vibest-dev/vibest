#!/usr/bin/env node

import path from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  resolveDaemonLocation,
  resolveOrSpawnDaemon,
  statusDaemon,
  stopDaemon,
} from "@vibest/server/daemon";
import { resolveServeConfig, serve, serveFlags } from "@vibest/server/http";
import { Effect, Option } from "effect";
import { Command } from "effect/unstable/cli";

import pkg from "../../package.json" with { type: "json" };

/**
 * argv that re-launches this very CLI in foreground `serve` mode. The daemon is
 * just `vibest serve` spawned detached — no second bundle, and `execArgv`
 * carries the dev loader (e.g. tsx) so it works from source too.
 */
function cliEntry(): string {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("vibest CLI entry path is unavailable");
  return path.resolve(entry);
}

function serverArgv(entry: string): string[] {
  return [process.execPath, ...process.execArgv, entry, "serve"];
}

type DaemonStartInput = {
  readonly port: Option.Option<number>;
  readonly corsOrigin: ReadonlyArray<string>;
  readonly allowedHost: ReadonlyArray<string>;
};

// Default startup is the daemon: a short-lived `vibest` command must operate a
// backend that outlives it, so it attaches to the running daemon or spawns one.
// Both directories come from the ambient environment through the shared
// resolver, which is also what `stop`/`status` and a desktop app inheriting the
// same `VIBEST_DAEMON_DIR` use — that is what makes them address one daemon.
const startDaemon = (input: DaemonStartInput) =>
  Effect.gen(function* () {
    // Same flag > env > default port precedence as `vibest serve`. CORS is not
    // resolved here: the daemon's policy is static, and any extra origins are
    // inherited from the ambient VIBEST_CORS_ORIGINS by the spawned daemon.
    const { port } = resolveServeConfig(input);
    const entry = cliEntry();
    const handle = yield* resolveOrSpawnDaemon({
      ...resolveDaemonLocation(),
      serverArgv: serverArgv(entry),
      launchOwnerPath: entry,
      port,
    });
    console.log(
      handle.reused
        ? `vibest daemon already running at ${handle.address} (pid ${handle.pid})`
        : `vibest daemon started at ${handle.address} (pid ${handle.pid})`,
    );
    const explicitPort = Option.getOrUndefined(input.port);
    if (handle.reused && explicitPort !== undefined && handle.port !== explicitPort) {
      console.log(
        `note: --port ${explicitPort} ignored — attached to the daemon already running on port ${handle.port}`,
      );
    }
  });

const stopHandler = () =>
  Effect.gen(function* () {
    const { daemonDir, legacyDaemonDir } = resolveDaemonLocation();
    const result = yield* stopDaemon(daemonDir, legacyDaemonDir);
    console.log(result === "stopped" ? "vibest daemon stopped" : "vibest daemon is not running");
  });

const statusHandler = () =>
  Effect.gen(function* () {
    const { daemonDir, legacyDaemonDir } = resolveDaemonLocation();
    const status = yield* statusDaemon(daemonDir, legacyDaemonDir);
    if (!status.running) {
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
