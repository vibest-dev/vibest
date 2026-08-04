import { QueryClient } from "@tanstack/react-query";
import type { ListSessionsOutput, SessionRef, ServerEvent } from "@vibest/contract";
import { describe, expect, it } from "vitest";

import { applySessionListEvent, type ListKeyFor } from "./session-list-cache";

const ref: SessionRef = {
  projectId: "project-1",
  harnessAgentId: "pi",
  sessionId: "session-1",
};

const listKeyFor: ListKeyFor = (projectId) => ["sessions", projectId];

const seed = (rows: ListSessionsOutput) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData<ListSessionsOutput>(listKeyFor(ref.projectId), rows);
  return queryClient;
};

const row = (overrides: Partial<ListSessionsOutput[number]> = {}): ListSessionsOutput[number] => ({
  ...ref,
  createdAt: "2026-08-03T00:00:00.000Z",
  historyAvailable: true,
  title: "hello",
  ...overrides,
});

const rows = (queryClient: QueryClient) =>
  queryClient.getQueryData<ListSessionsOutput>(listKeyFor(ref.projectId));

describe("applySessionListEvent", () => {
  it("copies the server-stamped phase onto the row", () => {
    const queryClient = seed([row()]);
    const event: ServerEvent = {
      ref,
      seq: 1,
      type: "session.turn.started",
      turnId: "turn-1",
      phase: "running",
    };
    applySessionListEvent(queryClient, listKeyFor, event);
    expect(rows(queryClient)?.[0]?.status).toEqual({ phase: "running" });
  });

  it("keeps the previous array object when the phase is unchanged", () => {
    const queryClient = seed([row({ status: { phase: "running" } })]);
    const before = rows(queryClient);
    const event: ServerEvent = {
      ref,
      seq: 2,
      type: "session.turn.started",
      turnId: "turn-1",
      phase: "running",
    };
    applySessionListEvent(queryClient, listKeyFor, event);
    expect(rows(queryClient)).toBe(before);
  });

  it("ignores chunk events entirely", () => {
    const queryClient = seed([row()]);
    const before = rows(queryClient);
    const event: ServerEvent = {
      ref,
      seq: 3,
      type: "session.message.chunk",
      turnId: "turn-1",
      chunk: { type: "text-delta", id: "t", delta: "x" },
      phase: "running",
    };
    applySessionListEvent(queryClient, listKeyFor, event);
    expect(rows(queryClient)).toBe(before);
  });

  it("merges an updated title into the existing row", () => {
    const queryClient = seed([row({ status: { phase: "running" } })]);
    const event: ServerEvent = { ref, type: "session.updated", title: "new title" };
    applySessionListEvent(queryClient, listKeyFor, event);
    expect(rows(queryClient)?.[0]).toMatchObject({
      title: "new title",
      status: { phase: "running" },
    });
  });

  it("invalidates the list when session.updated targets a row we don't hold", () => {
    const queryClient = seed([row()]);
    const event: ServerEvent = {
      ref: { ...ref, sessionId: "unknown-session" },
      type: "session.updated",
      title: "created elsewhere",
    };
    applySessionListEvent(queryClient, listKeyFor, event);
    expect(queryClient.getQueryState(listKeyFor(ref.projectId))?.isInvalidated).toBe(true);
  });

  it("renames and deletes rows in place", () => {
    const queryClient = seed([row(), row({ sessionId: "session-2", title: "other" })]);
    applySessionListEvent(queryClient, listKeyFor, { ref, type: "session.renamed", name: "named" });
    expect(rows(queryClient)?.[0]?.title).toBe("named");
    applySessionListEvent(queryClient, listKeyFor, { ref, type: "session.deleted" });
    expect(rows(queryClient)?.map((s) => s.sessionId)).toEqual(["session-2"]);
  });
});
