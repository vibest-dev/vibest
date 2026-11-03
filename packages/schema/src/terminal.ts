// What a command line and vibestd both need of the terminal and the disk: a whole-file write and a yes/no question.
import { type Duration, Effect, FileSystem, Option, Path, Random, Stdio, Stream } from "effect"

/** Readers never see half a file (SPEC §5.5): write a sibling temp file, then rename over the target. */
export const writeAtomic = Effect.fn("writeAtomic")(function* (
  file: string,
  content: string,
  options?: { readonly mode?: number },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  const tmp = `${file}.${yield* Random.nextIntBetween(0, 2 ** 31)}.tmp`
  yield* fs.writeFileString(tmp, content, options?.mode === undefined ? undefined : { mode: options.mode })
  yield* fs.rename(tmp, file)
})

/** Both ends on a terminal: the user sees the question and answers it themselves. */
export const interactive = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  return (yield* stdio.stdinIsTerminal) && (yield* stdio.stdoutIsTerminal)
})

/**
 * Print `question` (no newline) and read a line: y / yes is a yes; anything else, EOF or no answer within `timeout` is a no.
 * `defaultYes` (a `[Y/n]` question): an empty line is a yes too.
 */
export const askYesNo = (question: string, timeout: Duration.Input = "2 minutes", defaultYes = false) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(question), stdio.stdout()).pipe(Effect.ignore)
    const answer = yield* Stream.decodeText(stdio.stdin).pipe(
      Stream.splitLines,
      Stream.runHead,
      Effect.timeoutOption(timeout),
      Effect.orElseSucceed(() => Option.none()),
    )
    const line = Option.flatten(answer)
    if (defaultYes && Option.isSome(line) && line.value.trim() === "") return true
    return /^\s*y(es)?\s*$/i.test(Option.getOrElse(line, () => ""))
  })
