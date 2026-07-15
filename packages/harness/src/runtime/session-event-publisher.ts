import { Context, Effect, Layer } from "effect";

import type { SessionEnvelopeDraft } from "../types/envelope";

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
