import { Stream } from "effect";

/** oRPC event-iterator seam; harness/provider APIs remain Effect Stream native. */
export async function* streamToAsyncGenerator<A, E>(
  stream: Stream.Stream<A, E>,
): AsyncGenerator<A> {
  yield* Stream.toAsyncIterable(stream);
}
