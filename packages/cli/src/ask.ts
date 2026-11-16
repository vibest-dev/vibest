import { type Duration, Effect, Option, Stdio, Stream } from "effect"

export const interactive = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  return (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal)
})

export const askLine = (question: string, timeout: Duration.Input = "2 minutes") =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(question), stdio.stdout()).pipe(Effect.ignore)
    const answer = yield* Stream.decodeText(stdio.stdin).pipe(
      Stream.splitLines,
      Stream.runHead,
      Effect.timeoutOption(timeout),
      Effect.orElseSucceed(() => Option.none()),
    )
    return Option.flatten(answer)
  })

export const askYesNo = (question: string, timeout: Duration.Input = "2 minutes", defaultYes = false) =>
  Effect.map(askLine(question, timeout), (line) => {
    if (defaultYes && Option.isSome(line) && line.value.trim() === "") return true
    return /^\s*y(es)?\s*$/i.test(Option.getOrElse(line, () => ""))
  })
