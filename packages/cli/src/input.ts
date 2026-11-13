import { Effect, Schema, Stdio, Stream } from "effect"

export class EmptyInput extends Schema.TaggedError<EmptyInput>()("EmptyInput", { message: Schema.String }) {}

export const input = (value: string, what: string) =>
  Effect.gen(function* () {
    const text = value === "-" ? yield* Stream.mkString(Stream.decodeText((yield* Stdio.Stdio).stdin)) : value
    if (text.trim() === "") return yield* new EmptyInput({ message: `the ${what} is empty` })
    return text
  })
