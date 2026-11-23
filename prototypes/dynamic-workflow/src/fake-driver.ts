import { type Driver, type Reply, type SpawnRequest, aborted, outcomeOf, sleep } from "./driver.ts"

export interface FakeTurn {
  readonly session: string
  readonly title: string
  readonly harness: string | undefined
  readonly prompt: string
  readonly turn: number
  readonly history: ReadonlyArray<string>
}

export type FakeAnswer =
  | { readonly text: string; readonly delay?: number }
  | { readonly fail: string; readonly delay?: number }
  | { readonly hang: true }

export type Respond = (turn: FakeTurn) => FakeAnswer | Promise<FakeAnswer>

interface FakeSession {
  readonly request: SpawnRequest
  readonly history: Array<string>
  readonly replies: Array<Reply>
  readonly waiters: Array<() => void>
  executions: number
  running: AbortController | undefined
  tail: Promise<void>
  archived: boolean
}

export class FakeVibestDriver implements Driver {
  readonly calls: Array<string> = []
  private readonly sessions = new Map<string, FakeSession>()

  constructor(private readonly respond: Respond) {}

  readonly spawn = async (request: SpawnRequest) => {
    const id = `s${this.sessions.size + 1}`
    this.sessions.set(id, {
      request,
      history: [],
      replies: [],
      waiters: [],
      executions: 0,
      running: undefined,
      tail: Promise.resolve(),
      archived: false,
    })
    this.calls.push(`spawn ${id} ${request.title}`)
    this.enqueue(id, request.prompt)

    return id
  }

  readonly send = async (id: string, message: string) => {
    this.calls.push(`send ${id}`)
    this.enqueue(id, message)
  }

  readonly reply = async (id: string, after: number, signal: AbortSignal) => {
    const session = this.get(id)

    for (;;) {
      const found = session.replies.find((reply) => reply.execution > after)

      if (found !== undefined) return found
      await Promise.race([new Promise<void>((resolve) => session.waiters.push(resolve)), aborted(signal)])
    }
  }

  readonly interrupt = async (id: string) => {
    this.calls.push(`interrupt ${id}`)
    this.get(id).running?.abort()
  }

  readonly archive = async (id: string) => {
    this.calls.push(`archive ${id}`)
    this.get(id).archived = true
  }

  isArchived(id: string) {
    return this.get(id).archived
  }

  history(id: string) {
    return this.get(id).history
  }

  private get(id: string) {
    const session = this.sessions.get(id)

    if (session === undefined) throw new Error(`no fake session ${id}`)

    return session
  }

  private enqueue(id: string, message: string) {
    const session = this.get(id)
    session.tail = session.tail.then(() => this.execute(id, session, message))
  }

  private async execute(id: string, session: FakeSession, message: string) {
    const running = new AbortController()
    session.running = running
    session.executions += 1
    const execution = session.executions
    session.history.push(message)

    const answer = await this.respond({
      session: id,
      title: session.request.title,
      harness: session.request.harness,
      prompt: message,
      turn: execution,
      history: [...session.history],
    })

    const reply = await this.answered(answer, execution, running.signal).catch((): Reply => ({
      execution,
      outcome: "interrupted",
      text: "",
      failure: undefined,
    }))

    session.running = undefined
    session.history.push(reply.text)
    session.replies.push(reply)

    for (const wake of session.waiters.splice(0)) wake()
  }

  private async answered(answer: FakeAnswer, execution: number, signal: AbortSignal): Promise<Reply> {
    if ("hang" in answer) return aborted(signal)
    await sleep(answer.delay ?? 0, signal)

    if ("fail" in answer)
      return { execution, outcome: outcomeOf("failed", "", answer.fail), text: "", failure: answer.fail }

    return { execution, outcome: outcomeOf("completed", answer.text, undefined), text: answer.text, failure: undefined }
  }
}
