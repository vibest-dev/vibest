import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  useMatch,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import type { SessionRef } from "@vibest/contract";
import { useCallback } from "react";

import {
  AppShell,
  AppShellBody,
  AppShellMain,
  AppShellSidebar,
} from "@/components/layout/app-shell";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { CardPanel } from "@/components/layout/card-panel";
import { browserPanel } from "@/components/layout/content-panel/panels/browser-panel";
import { diffPanel } from "@/components/layout/content-panel/panels/diff-panel";
import { terminalPanel } from "@/components/layout/content-panel/panels/terminal-panel";
import { ContentPanelSessionProvider } from "@/components/layout/content-panel/react/session-provider";
import { contentPanel } from "@/content-panel";
import { filePanel } from "@/features/files/file-panel";
import { filesPanel } from "@/features/files/files-panel";
import { useProjectSessionTitle } from "@/features/projects/use-project-sessions";
import { useProject } from "@/features/projects/use-projects";
import { useSessionListSync } from "@/features/projects/use-session-list-sync";
import type { AppClients } from "@/lib/orpc";
import { sameSessionRef } from "@/lib/session-ref";
import { usePlatform } from "@/platform-context";

export interface RouterAppContext {
  orpcClient: AppClients["orpcClient"];
  orpcQueryUtils: AppClients["orpcQueryUtils"];
  queryClient: QueryClient;
}

contentPanel.registerAll([filesPanel, filePanel, terminalPanel, diffPanel, browserPanel]);

export const Route = createRootRouteWithContext<RouterAppContext>()({
  // Fetch the harness list once, right after the client connects and before
  // any route renders. Every consumer (e.g. the permission-mode picker) then
  // reads the held result by id.
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      context.orpcQueryUtils.harness.list.queryOptions({ input: {} }),
    ),
  component: RootLayout,
});

// Global shell: left sidebar + floating card panel; every route renders in the card.
function RootLayout() {
  // Keeps every `session.list` cache converged from the server's events
  // (multi-tab / desktop), independent of which route is mounted.
  useSessionListSync();
  const navigate = useNavigate();
  const { os } = usePlatform();

  // This is the shell's one route-identity seam: the content panel, active
  // sidebar row, and card heading all derive from the same authoritative ref.
  // The content panel is bound here rather than in the session route because it
  // is a peer card whose maximized state controls the whole shell.
  //
  // A named match, not `useParams({ strict: false })`: this component *is* the
  // root route's, so the nearest match is always the root — which has no params
  // — and the session route's would never be seen. The match's loaderData is
  // also the ref the server confirmed, unlike the URL's search hints. Off a
  // session route it is null and every panel hook degrades to a no-op.
  const sessionRef =
    useMatch({
      from: "/session/$sessionId",
      shouldThrow: false,
      select: (match) => match.loaderData ?? null,
    }) ?? null;
  const draftProjectId = useMatch({
    from: "/draft",
    shouldThrow: false,
    select: (match) => match.search.projectId ?? null,
  });
  const project = useProject(sessionRef?.projectId ?? draftProjectId);
  const sessionTitle = useProjectSessionTitle(sessionRef ?? undefined);
  // Mutations can settle after navigation. Read the router's current match at
  // call time instead of capturing a render-time `active` boolean.
  const router = useRouter();
  const isSessionActive = useCallback(
    (candidate: SessionRef) => {
      const current = router.state.matches.find(
        (match) => match.routeId === "/session/$sessionId",
      )?.loaderData;
      return sameSessionRef(candidate, current);
    },
    [router],
  );
  const handleNewChat = () => navigate({ to: "/draft" });

  return (
    <AppShell>
      <ContentPanelSessionProvider contentPanel={contentPanel} sessionRef={sessionRef}>
        <AppShellBody>
          <AppShellSidebar>
            <AppSidebar isSessionActive={isSessionActive} onNewChat={handleNewChat} />
          </AppShellSidebar>
          <AppShellMain>
            <CardPanel
              hasTrafficLights={os === "macos"}
              heading={sessionRef === null ? "New chat" : (sessionTitle ?? "New chat")}
              supportingText={project?.name}
            />
          </AppShellMain>
        </AppShellBody>
      </ContentPanelSessionProvider>
    </AppShell>
  );
}
