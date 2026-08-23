import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ArchiveSessionInputSchema,
  CollectionEventTypes,
  HarnessListOutputSchema,
  HarnessProbeInputSchema,
  HarnessProbeOutputSchema,
  ListSessionsInputSchema,
  MAX_SESSION_TITLE_CHARS,
  RenameSessionInputSchema,
  type ServerEvent,
  serverErrors,
  ServerErrorCodes,
  isSessionScopedEvent,
  PromptInputSchema,
  SessionRefSchema,
  SteerInputSchema,
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

describe("ArchiveSessionInput", () => {
  it("requires an explicit archived state", () => {
    expect(accepts(ArchiveSessionInputSchema, { ref, archived: true })).toBe(true);
    expect(accepts(ArchiveSessionInputSchema, { ref })).toBe(false);
  });
});

describe("RenameSessionInput", () => {
  it("accepts a trimmed, non-empty title within the bound", () => {
    expect(accepts(RenameSessionInputSchema, { ref, title: "Login bug" })).toBe(true);
    expect(
      accepts(RenameSessionInputSchema, { ref, title: "x".repeat(MAX_SESSION_TITLE_CHARS) }),
    ).toBe(true);
  });

  it("rejects a title that would render as a blank row", () => {
    expect(accepts(RenameSessionInputSchema, { ref, title: "" })).toBe(false);
    expect(accepts(RenameSessionInputSchema, { ref, title: "   " })).toBe(false);
    // Untrimmed rather than blank, but the server stores the string as given.
    expect(accepts(RenameSessionInputSchema, { ref, title: " Login bug " })).toBe(false);
  });

  it("rejects a title past the bound", () => {
    expect(
      accepts(RenameSessionInputSchema, { ref, title: "x".repeat(MAX_SESSION_TITLE_CHARS + 1) }),
    ).toBe(false);
  });

  it("rejects the legacy name field", () => {
    expect(accepts(RenameSessionInputSchema, { ref, name: "Login bug" })).toBe(false);
  });
});

describe("ListSessionsInput", () => {
  it("accepts an archived filter and lets callers omit it for the active default", () => {
    expect(accepts(ListSessionsInputSchema, { projectId: UUID, archived: false })).toBe(true);
    expect(accepts(ListSessionsInputSchema, { projectId: UUID, archived: true })).toBe(true);
    expect(accepts(ListSessionsInputSchema, { projectId: UUID })).toBe(true);
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

describe("SteerInput", () => {
  it("requires the queued message id and the exact active turn", () => {
    expect(
      accepts(SteerInputSchema, {
        ref,
        expectedTurnId: "turn-1",
        messageId: "message-1",
        parts: [{ type: "text", text: "change direction" }],
      }),
    ).toBe(true);
    expect(
      accepts(SteerInputSchema, {
        ref,
        messageId: "message-1",
        parts: [{ type: "text", text: "change direction" }],
      }),
    ).toBe(false);
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

describe("HarnessListOutput", () => {
  const listing = (entry: Record<string, unknown>) => ({
    harnessAgents: [{ id: "codex", name: "Codex", available: true, ...entry }],
  });

  it("carries the permission subset as our closed vocabulary, with its default", () => {
    expect(
      accepts(
        HarnessListOutputSchema,
        listing({
          permissionModes: ["read-only", "ask", "full"],
          defaultPermissionMode: "ask",
        }),
      ),
    ).toBe(true);
  });

  it("accepts an empty subset — how a harness says it has no permission protocol", () => {
    expect(accepts(HarnessListOutputSchema, listing({ permissionModes: [] }))).toBe(true);
  });

  it("rejects a mode outside the vocabulary — labels and native ids never travel", () => {
    expect(
      accepts(HarnessListOutputSchema, listing({ permissionModes: ["bypassPermissions"] })),
    ).toBe(false);
    expect(
      accepts(HarnessListOutputSchema, listing({ permissionModes: [{ id: "ask", label: "Ask" }] })),
    ).toBe(false);
  });

  it("requires the subset — the field is an answer, not an option", () => {
    expect(
      accepts(HarnessListOutputSchema, {
        harnessAgents: [{ id: "codex", name: "Codex", available: false }],
      }),
    ).toBe(false);
  });
});

describe("HarnessProbeOutput", () => {
  const output = (providers: unknown) => ({ providers });

  it("keeps models inside their provider", () => {
    expect(
      accepts(
        HarnessProbeOutputSchema,
        output([{ id: "codex", models: [{ id: "gpt-5.6-sol", label: "GPT 5.6 Sol" }] }]),
      ),
    ).toBe(true);
  });

  it("accepts an empty provider list — how a harness says it has no model switch", () => {
    expect(accepts(HarnessProbeOutputSchema, output([]))).toBe(true);
  });

  it("carries normalized traits next to the opaque id", () => {
    expect(
      accepts(
        HarnessProbeOutputSchema,
        output([
          {
            id: "codex",
            models: [
              {
                id: "gpt-5.6-sol",
                reasoningEfforts: ["low", "medium", "high"],
                defaultReasoningEffort: "medium",
                modalities: ["text", "image"],
              },
            ],
          },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects an reasoningEffort outside the vocabulary — adapters must drop what they can't translate", () => {
    expect(
      accepts(
        HarnessProbeOutputSchema,
        output([{ id: "codex", models: [{ id: "m", reasoningEfforts: ["turbo"] }] }]),
      ),
    ).toBe(false);
  });

  it("rejects a model without an id", () => {
    expect(
      accepts(HarnessProbeOutputSchema, output([{ id: "codex", models: [{ label: "Sonnet" }] }])),
    ).toBe(false);
  });

  it("addresses a probe by directory, not by project", () => {
    expect(accepts(HarnessProbeInputSchema, { harnessAgentId: "codex", cwd: "/work/app" })).toBe(
      true,
    );
    expect(accepts(HarnessProbeInputSchema, { harnessAgentId: "codex" })).toBe(false);
  });
});
