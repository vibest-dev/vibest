import type { SessionEnvelopeDraft } from "@vibest/harness";
import { Context, Effect, Layer } from "effect";

export type SessionEventPublisherShape = {
  readonly publish: (event: SessionEnvelopeDraft) => Effect.Effect<number>;
};

export class SessionEventPublisher extends Context.Service<
  SessionEventPublisher,
  SessionEventPublisherShape
>()("SessionEventPublisher") {}

export const SessionEventPublisherLayer = (
  publisher: SessionEventPublisherShape,
): Layer.Layer<SessionEventPublisher> => Layer.succeed(SessionEventPublisher, publisher);
