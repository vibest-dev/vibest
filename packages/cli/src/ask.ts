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

export const askChoice = (
  question: string,
  options: ReadonlyArray<string>,
  timeout: Duration.Input = "2 minutes",
): Effect.Effect<Option.Option<number>, never, Stdio.Stdio> =>
  Effect.gen(function* () {
    const menu = options.map((option, i) => `  ${i + 1}. ${option}`).join("\n")
    const line = yield* askLine(`${question}\n${menu}\nChoose [1]: `, timeout)

    if (Option.isNone(line)) return Option.none()
    const answer = line.value.trim()

    if (answer === "") return Option.some(0)
    const picked = /^\d+$/.test(answer) ? Number(answer) - 1 : -1

    return picked >= 0 && picked < options.length ? Option.some(picked) : yield* askChoice(question, options, timeout)
  })

export const askYesNo = (question: string, timeout: Duration.Input = "2 minutes", defaultYes = false) =>
  Effect.map(askLine(question, timeout), (line) => {
    if (defaultYes && Option.isSome(line) && line.value.trim() === "") return true

    return /^\s*y(es)?\s*$/i.test(Option.getOrElse(line, () => ""))
  })
