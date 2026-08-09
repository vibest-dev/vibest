// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionSummary } from "@vibest/contract";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn<
    (options: { input: { projectId: string; archived: boolean } }) => {
      queryKey: ReadonlyArray<unknown>;
      queryFn: () => Promise<ReadonlyArray<SessionSummary>>;
    }
  >(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouteContext: () => ({
    orpcQueryUtils: { session: { list: { queryOptions: mocks.queryOptions } } },
  }),
}));

import { selectProjectSession, useProjectSession } from "./use-project-sessions";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (sessionId: string, title: string, archived = false): SessionSummary => ({
  projectId: "project-1",
  harnessAgentId: "pi",
  sessionId,
  title,
  archived,
  createdAt: "2026-08-08T00:00:00.000Z",
  historyAvailable: true,
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function Probe({ sessionId }: { sessionId: string }) {
  const selected = useProjectSession("project-1", sessionId);
  return createElement("span", null, selected?.title ?? "missing");
}

const renderSession = async (
  sessionId: string,
  active: ReadonlyArray<SessionSummary>,
  archived: ReadonlyArray<SessionSummary> = [],
): Promise<string> => {
  mocks.queryOptions.mockImplementation(
    ({ input }: { input: { projectId: string; archived: boolean } }) => ({
      queryKey: ["session.list", input],
      queryFn: async () => (input.archived ? archived : active),
    }),
  );
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Probe, { sessionId }),
      ),
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(host?.textContent).not.toBe("missing"));
  });
  return host.textContent ?? "";
};

afterEach(() => {
  const mounted = root;
  act(() => mounted?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  mocks.queryOptions.mockReset();
});

describe("selectProjectSession", () => {
  it("selects the title for the active session instead of reusing another session's header", () => {
    const sessions = [session("session-1", "First chat"), session("session-2", "Second chat")];

    expect(selectProjectSession(sessions, "session-1")?.title).toBe("First chat");
    expect(selectProjectSession(sessions, "session-2")?.title).toBe("Second chat");
  });
});

describe("useProjectSession", () => {
  it("reads an active session title from the project list", async () => {
    await expect(
      renderSession("session-2", [
        session("session-1", "First chat"),
        session("session-2", "Second chat"),
      ]),
    ).resolves.toBe("Second chat");
  });

  it("falls back to the archived list for a valid archived-session route", async () => {
    await expect(
      renderSession("session-3", [], [session("session-3", "Archived chat", true)]),
    ).resolves.toBe("Archived chat");
  });
});
