import { Schema } from "effect"

import { type Driver, type Reply, type SpawnRequest, outcomeOf, sleep } from "./driver.ts"

const Spawned = Schema.fromJsonString(Schema.Struct({ id: Schema.String }))

const SessionResult = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    reply: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          execution: Schema.Number,
          status: Schema.String,
          text: Schema.NullOr(Schema.String),
          failure: Schema.NullOr(Schema.String),
        }),
      ),
    ),
  }),
)

const decodeSpawned = Schema.decodeUnknownSync(Spawned)
const decodeResult = Schema.decodeUnknownSync(SessionResult)
const ENDED = new Set(["completed", "failed", "interrupted"])
const POLL_START_MS = 1000
const POLL_MAX_MS = 10000
const TRANSIENT_FAILURES = 30

export class VibestCliFailed extends Error {}

const flag = (name: string, value: string | undefined) => (value === undefined ? [] : [`--${name}`, value])

export class VibestCliDriver implements Driver {
  constructor(
    private readonly bin: string = Bun.env.VIBEST_CLI ?? "vibest",
    private readonly firstPollMs: number = POLL_START_MS,
  ) {}

  readonly spawn = async (request: SpawnRequest) =>
    decodeSpawned(
      await this.vibest([
        "run",
        ...(request.harness === undefined ? [] : [request.harness]),
        "--title",
        request.title,
        ...flag("agent", request.agent),
        ...flag("provider", request.provider),
        ...flag("model", request.model),
        "--",
        request.prompt,
      ]),
    ).id

  readonly send = async (id: string, message: string) => {
    await this.vibest(["send", id, "--", message])
  }

  readonly reply = async (id: string, after: number, signal: AbortSignal): Promise<Reply> => {
    let wait = this.firstPollMs
    let failures = 0

    for (;;) {
      signal.throwIfAborted()

      const seen = await this.vibest(["result", id]).then(
        (text) => decodeResult(text),
        (error) => {
          failures += 1

          if (failures > TRANSIENT_FAILURES) throw error

          return undefined
        },
      )

      const reply = seen?.reply

      if (reply != null && reply.execution > after && ENDED.has(reply.status)) {
        const text = reply.text ?? ""

        return {
          execution: reply.execution,
          outcome: outcomeOf(reply.status, text, reply.failure ?? undefined),
          text,
          failure: reply.failure ?? undefined,
        }
      }

      if (seen?.status === "blocked")
        return {
          execution: after,
          outcome: "blocked",
          text: "",
          failure: "the session waits for a permission decision",
        }
      await sleep(wait, signal)
      wait = Math.min(wait * 2, POLL_MAX_MS)
    }
  }

  readonly interrupt = async (id: string) => {
    await this.vibest(["interrupt", id])
  }

  readonly archive = async (id: string) => {
    await this.vibest(["archive", id])
  }

  private async vibest(args: ReadonlyArray<string>) {
    const child = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" })

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    if (code !== 0) throw new VibestCliFailed(`vibest ${args[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`)

    return stdout
  }
}
