import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ListSessionsOutput, SessionRef, ServerEvent } from "@vibest/contract";
import { describe, expect, it, vi } from "vitest";

import {
  applySessionListEvent,
  type ListKeyFor,
  reconcileSessionRenameSuccess,
} from "./session-list-cache";

const ref: SessionRef = {
  projectId: "project-1",
  harnessAgentId: "pi",
  sessionId: "session-1",
};

const listKeyFor: ListKeyFor = (projectId, archived) => ["sessions", projectId, archived];

const seed = (rows: ListSessionsOutput) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData<ListSessionsOutput>(listKeyFor(ref.projectId, false), rows);
  return queryClient;
};

const row = (overrides: Partial<ListSessionsOutput[number]> = {}): ListSessionsOutput[number] => ({
  ...ref,
  archived: false,
  createdAt: "2026-08-03T00:00:00.000Z",
  historyAvailable: true,
  title: "hello",
  ...overrides,
});

const rows = (queryClient: QueryClient) =>
  queryClient.getQueryData<ListSessionsOutput>(listKeyFor(ref.projectId, false));

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
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, false))?.isInvalidated).toBe(true);
  });

  it("removes an archived row from the active cache and invalidates the archived cache", () => {
    const queryClient = seed([row()]);
    queryClient.setQueryData<ListSessionsOutput>(listKeyFor(ref.projectId, true), []);
    applySessionListEvent(queryClient, listKeyFor, {
      ref,
      type: "session.archived",
      archived: true,
    });
    expect(rows(queryClient)).toEqual([]);
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, true))?.isInvalidated).toBe(true);
  });

  it("renames and deletes rows in place", () => {
    const queryClient = seed([row(), row({ sessionId: "session-2", title: "other" })]);
    applySessionListEvent(queryClient, listKeyFor, {
      ref,
      type: "session.renamed",
      title: "named",
    });
    expect(rows(queryClient)?.[0]?.title).toBe("named");
    applySessionListEvent(queryClient, listKeyFor, { ref, type: "session.deleted" });
    expect(rows(queryClient)?.map((s) => s.sessionId)).toEqual(["session-2"]);
  });

  // Duplicate delivery is harmless: re-writing the array for an already
  // applied title would re-render every row for no change.
  it("keeps the array identity when a rename event carries the title already shown", () => {
    const queryClient = seed([row({ title: "named" })]);
    const before = rows(queryClient);
    applySessionListEvent(queryClient, listKeyFor, {
      ref,
      type: "session.renamed",
      title: "named",
    });
    expect(rows(queryClient)).toBe(before);
  });

  // Rename events write the cache directly and never fetch. Driven through a
  // live QueryObserver because an inactive query would not expose an accidental
  // refetch — that would prove nothing.
  it("writes a rename straight into a live cache without refetching it", async () => {
    const queryClient = new QueryClient();
    const key = listKeyFor(ref.projectId, false);
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        fetches += 1;
        return [row()];
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      // Wait for the row to land, not just for queryFn to be entered — the
      // counter ticks before the result is written.
      await vi.waitFor(() => expect(rows(queryClient)).toHaveLength(1));
      expect(fetches).toBe(1);

      applySessionListEvent(queryClient, listKeyFor, {
        ref,
        type: "session.renamed",
        title: "named",
      });
      expect(rows(queryClient)?.[0]?.title).toBe("named");
      expect(fetches).toBe(1);

      // The contrast: invalidating the same live query *does* go back out.
      await queryClient.invalidateQueries({ queryKey: key });
      expect(fetches).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  // The event carries the complete title, so an existing row needs no refetch.
  it("folds a rename in place without invalidating either list", () => {
    const queryClient = seed([row()]);
    applySessionListEvent(queryClient, listKeyFor, {
      ref,
      type: "session.renamed",
      title: "named",
    });
    expect(rows(queryClient)?.[0]?.title).toBe("named");
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, false))?.isInvalidated).toBe(false);
    expect(
      queryClient.getQueryState(listKeyFor(ref.projectId, true))?.isInvalidated,
    ).toBeUndefined();
  });

  it("invalidates both lists when a rename targets a row we don't hold", () => {
    const queryClient = seed([]);
    queryClient.setQueryData<ListSessionsOutput>(listKeyFor(ref.projectId, true), []);
    applySessionListEvent(queryClient, listKeyFor, {
      ref,
      type: "session.renamed",
      title: "named",
    });
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, false))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, true))?.isInvalidated).toBe(true);
  });
});

describe("reconcileSessionRenameSuccess", () => {
  it("patches the starting title when the firehose event was missed", () => {
    const queryClient = seed([row({ title: "before" })]);
    reconcileSessionRenameSuccess(queryClient, listKeyFor, ref, "before", "after");
    expect(rows(queryClient)?.[0]?.title).toBe("after");
  });

  it("preserves a different title already applied by a newer event", () => {
    const queryClient = seed([row({ title: "newer" })]);
    const before = rows(queryClient);
    reconcileSessionRenameSuccess(queryClient, listKeyFor, ref, "before", "after");
    expect(rows(queryClient)).toBe(before);
    expect(rows(queryClient)?.[0]?.title).toBe("newer");
  });

  it("invalidates both lists when the initiating tab no longer holds the row", () => {
    const queryClient = seed([]);
    queryClient.setQueryData<ListSessionsOutput>(listKeyFor(ref.projectId, true), []);
    reconcileSessionRenameSuccess(queryClient, listKeyFor, ref, "before", "after");
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, false))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(listKeyFor(ref.projectId, true))?.isInvalidated).toBe(true);
  });
});
