import childProcess from "node:child_process"
import path from "node:path"
import util from "node:util"

import { Plugin, Runtime } from "@vibest/plugin/effect"
import { Effect, Stream } from "effect"

const execFile = util.promisify(childProcess.execFile)
const root = process.env.VIBEST_HOME && path.dirname(process.env.VIBEST_HOME)
if (!root?.startsWith("/tmp/vbe-") || process.env.HC_SOCKET !== root + "/hc.sock")
  throw new Error("status fixture requires its isolated E2E core")
const prefix = root.split("/").at(-1)!
const id = (terminal: Runtime.Terminal) => terminal.id.slice(prefix.length + 1)
const hc = (...argv: Array<string>) =>
  Effect.tryPromise({
    try: async () => (await execFile("hc", argv, { env: process.env, timeout: 30_000 })).stdout,
    catch: (e) => new Runtime.RuntimeError({ code: "failed", message: String(e) }),
  })
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
const runtime: Runtime.RuntimeDefinition = {
  id: "status-fixture",
  status: () => Effect.succeed({ status: "online" }),
  open: (input) =>
    hc(
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--cwd",
      input.cwd,
      "--",
      "env",
      ...Object.entries(input.env).map(([k, v]) => k + "=" + v),
      "python3",
      "-I",
      path.join(root, "status-pty.py"),
      path.join(root, "status-output", crypto.randomUUID()),
      ...input.argv,
    ).pipe(Effect.map((raw) => ({ id: prefix + "/" + JSON.parse(raw).address }))),
  send: (terminal, input) =>
    hc(
      ...(input.text !== undefined
        ? ["send", id(terminal), input.text]
        : ["keys", id(terminal), ...(input.keys ?? [])]),
    ).pipe(Effect.asVoid),
  run: (terminal, argv) => hc("send", id(terminal), argv.map(quote).join(" ")).pipe(Effect.asVoid),
  read: (terminal, lines) => hc("read", id(terminal), "--lines", String(lines)),
  process: (terminal) =>
    hc("get", id(terminal)).pipe(Effect.map((raw) => ({ running: JSON.parse(raw).state === "live" }))),
  close: (terminal) => hc("kill", id(terminal)).pipe(Effect.asVoid),
  events: Stream.never,
}
export default Plugin.define({
  id: "status-fixture",
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* ctx.runtime.transform((editor) => editor.add(runtime))
      yield* ctx.agent.hook("start.before", () => Effect.succeed({ runtime: runtime.id }))
    }),
})
