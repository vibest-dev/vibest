// Example runtime plugin and its use, against runtime-api.ts. tern is the simplest product (CLI only), so it shows the
// minimum a runtime plugin needs. Field names of tern's --json output are illustrative.
// The package's export shape: the `Plugin` and `Runtime` namespaces; `Runtime` also holds `RuntimeError` and the types.
import { Plugin, Runtime } from "@vibest/plugin"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

type Machine = Runtime.Machine
type Terminal = Runtime.Terminal

// ── The plugin ────────────────────────────────────────────────────────────────────────────────────────────

/** One tern CLI call on a machine: local runs `tern …`, a saved machine runs `tern ssh <target> tern …`. */
const tern = (machine: Machine, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const argv = machine.id === "local" ? ["tern", ...args] : ["tern", "ssh", machine.target!, "tern", ...args]
    return yield* spawner.string(ChildProcess.make(argv[0]!, argv.slice(1)))
  }).pipe(
    Effect.mapError((cause) =>
      new Runtime.RuntimeError({ code: /no such block|not found/i.test(String(cause)) ? "not_found" : "failed", message: String(cause) }),
    ),
  )
const json = (machine: Machine, args: ReadonlyArray<string>) => tern(machine, [...args, "--json"]).pipe(Effect.map((out) => JSON.parse(out)))
const on = (terminal: Terminal): Machine => ({ id: terminal.machine })

const runtime: Runtime.Runtime = {
  kind: "tern",

  status: (machine) =>
    tern(machine, ["ls"]).pipe(
      Effect.as({ status: "online" as const }),
      Effect.catchAll((e) => Effect.succeed({ status: machine.id === "local" ? "blocked" as const : "offline" as const, reason: e.message })),
    ),

  open: (machine, { project, cwd, argv, env, label, near }) =>
    Effect.gen(function* () {
      const sessions = yield* json(machine, ["ls"])
      if (!sessions.some((s: { name: string }) => s.name === project)) yield* tern(machine, ["new", "session", project])
      const where = near ? ["split", near.id, "right"] : ["new", "tab", project]
      // tern has no env flag: env(1) sets it, then runs argv exactly.
      const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`)
      const created = yield* json(machine, [...where, "--cwd", cwd, "--keep-open", "--", "/usr/bin/env", ...envArgs, ...argv])
      yield* tern(machine, ["rename", created.block, label])
      return { machine: machine.id, id: created.block }
    }),

  send: (terminal, { text, keys }) =>
    Effect.gen(function* () {
      if (text !== undefined) yield* tern(on(terminal), ["send", terminal.id, "paste", text])
      if (keys?.length) yield* tern(on(terminal), ["send", terminal.id, "keys", ...keys])
    }),

  read: (terminal, lines) =>
    tern(on(terminal), ["capture", terminal.id, "--scrollback"]).pipe(Effect.map((out) => out.split("\n").slice(-lines).join("\n"))),

  process: (terminal) =>
    json(on(terminal), ["process", terminal.id]).pipe(Effect.map((p) => ({ running: p.child != null, exitCode: p.exit_code ?? undefined }))),

  close: (terminal) => tern(on(terminal), ["close", terminal.id]).pipe(Effect.asVoid),

  // Optional members tern has. No `state`, `events`, `exec`: core falls back (integration reports, polling, a hidden
  // terminal for one-off commands).
  present: (terminal, info) => tern(on(terminal), ["rename", terminal.id, info.title ?? terminal.id]).pipe(Effect.asVoid),
  prepare: (machine) => tern({ id: "local" }, ["remote", "setup", machine.target!]).pipe(Effect.asVoid),
  attach: () => ["tern"],
}

export default Plugin.define({
  id: "runtime-tern",
  effect: (context) => context.runtime.register(runtime),
})

// ── Using it ──────────────────────────────────────────────────────────────────────────────────────────────
//
// ~/.vibest/vibest.json (tern is builtin; a third-party runtime is listed under "plugins"):
//
//   {
//     "runtime": "tern",
//     "plugins": [{ "package": "./plugins/send-reviews-to-cloud.ts" }],
//     "machines": { "cloud": { "runtimes": { "herdr": "ssh://ubuntu@66.80.0.50", "tern": "ubuntu@66.80.0.50" } } }
//   }
//
// Shell:
//
//   vibest machine add cloud ssh://ubuntu@66.80.0.50 --runtime herdr
//   vibest machine list
//   cd shop && vibest            # main Agent in tern; ask it to delegate
//   vibest ls                    # each Agent with its runtime and machine
//
// A policy plugin choosing the machine (a hook, not a runtime):

export const sendReviewsToCloud = Plugin.define({
  id: "send-reviews-to-cloud",
  effect: (context) =>
    context.agent.hook("start.before", (event) =>
      Effect.sync(() => {
        const cloud = event.machines.find((m) => m.machine === "cloud" && m.runtimes.some((r) => r.kind === "herdr" && r.status === "online"))
        if (event.agentType === "reviewer" && cloud) { event.machine = "cloud"; event.runtime = "herdr" }
      }),
    ),
})

// Testing the plugin (author):
//
//   import { runtimeContract } from "@vibest/plugin/testing"
//   it.effect("tern passes the runtime contract", () => runtimeContract(runtime))
