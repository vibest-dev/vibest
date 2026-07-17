import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CollectionEventTypes,
  type ServerEvent,
  serverErrors,
  ServerErrorCodes,
  isSessionScopedEvent,
  PromptInputSchema,
  SessionRefSchema,
  SessionScopedEventTypes,
  SubscribeInputSchema,
} from "../src/domain";

const UUID = "0195b4b3-6dc4-7d41-a9ce-3ab5dcb6cc61";
const ref = { projectId: UUID, harnessAgentId: "claude-code", sessionId: "s1" };

const accepts = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown): boolean =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));

describe("SessionRef", () => {
  it("accepts a UUID projectId with a non-empty sessionId", () => {
    expect(accepts(SessionRefSchema, ref)).toBe(true);
  });

  it("rejects a non-UUID projectId", () => {
    expect(accepts(SessionRefSchema, { ...ref, projectId: "not-a-uuid" })).toBe(false);
  });

  it("rejects an empty sessionId", () => {
    expect(accepts(SessionRefSchema, { ...ref, sessionId: "" })).toBe(false);
  });

  it("rejects an unknown harness agent", () => {
    expect(accepts(SessionRefSchema, { ...ref, harnessAgentId: "gpt" })).toBe(false);
  });
});

describe("PromptInput", () => {
  it("accepts a text part", () => {
    expect(accepts(PromptInputSchema, { ref, parts: [{ type: "text", text: "hi" }] })).toBe(true);
  });

  it("rejects empty parts", () => {
    expect(accepts(PromptInputSchema, { ref, parts: [] })).toBe(false);
  });

  it("rejects an empty text part", () => {
    expect(accepts(PromptInputSchema, { ref, parts: [{ type: "text", text: "" }] })).toBe(false);
  });

  it("keeps the file part shape on the wire (validated, server rejects with UNSUPPORTED)", () => {
    expect(
      accepts(PromptInputSchema, {
        ref,
        parts: [{ type: "file", mediaType: "image/png", url: "https://x/y.png" }],
      }),
    ).toBe(true);
  });
});

describe("SubscribeInput scope", () => {
  it("accepts a session scope", () => {
    expect(accepts(SubscribeInputSchema, { scope: { kind: "session", ref } })).toBe(true);
  });

  it("accepts the global scope", () => {
    expect(accepts(SubscribeInputSchema, { scope: { kind: "global" } })).toBe(true);
  });

  it("rejects an unknown scope kind", () => {
    expect(accepts(SubscribeInputSchema, { scope: { kind: "project", projectId: UUID } })).toBe(
      false,
    );
  });
});

describe("event partition", () => {
  it("session-scoped and collection type sets are disjoint", () => {
    const collection = new Set<string>(CollectionEventTypes);
    for (const t of SessionScopedEventTypes) expect(collection.has(t)).toBe(false);
  });

  it("isSessionScopedEvent splits the union", () => {
    const chunk: ServerEvent = {
      ref,
      seq: 1,
      type: "session.turn.started",
      turnId: "t1",
    };
    const created: ServerEvent = { ref, type: "session.created" };
    expect(isSessionScopedEvent(chunk)).toBe(true);
    expect(isSessionScopedEvent(created)).toBe(false);
  });
});

describe("server error map", () => {
  it("exposes every stable code as an oRPC error entry", () => {
    for (const code of ServerErrorCodes) expect(serverErrors).toHaveProperty(code);
  });
});
