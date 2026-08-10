import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, useMatch } from "@tanstack/react-router";

import { AppShell } from "@/components/layout/app-shell";
import { ContentPanelProvider } from "@/components/layout/content-panel/react/provider";
import { RegisterPanels } from "@/components/layout/content-panel/react/register";
import { contentPanel, STATIC_PANELS } from "@/content-panel";
import { useSessionListSync } from "@/features/projects/use-session-list-sync";
import type { AppClients } from "@/lib/orpc";

export interface RouterAppContext {
  orpcClient: AppClients["orpcClient"];
  orpcQueryUtils: AppClients["orpcQueryUtils"];
  queryClient: QueryClient;
}

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

  // The content panel is session-scoped, but it is bound here rather than in the
  // session route: it is a card of the shell, peer to the chat's, and maximizing
  // it has to be able to take the chat card's width.
  //
  // A named match, not `useParams({ strict: false })`: this component *is* the
  // root route's, so the nearest match is always the root — which has no params
  // — and the session route's would never be seen. The match's loaderData is
  // also the ref the server confirmed, unlike the URL's search hints. Off a
  // session route it is null and every panel hook degrades to a no-op.
  const sessionId = useMatch({
    from: "/session/$sessionId",
    shouldThrow: false,
    select: (match) => match.loaderData?.sessionId ?? null,
  });

  return (
    <ContentPanelProvider contentPanel={contentPanel} sessionId={sessionId ?? null}>
      <RegisterPanels definitions={STATIC_PANELS} />
      <AppShell />
    </ContentPanelProvider>
  );
}
