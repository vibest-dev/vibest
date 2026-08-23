import { useRouteContext } from "@tanstack/react-router";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@vibest/ui/components/empty";
import { Spinner } from "@vibest/ui/components/spinner";
import { TerminalIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { PanelInstance } from "@/components/layout/content-panel/model/panel";
import { definePanelFamily } from "@/components/layout/content-panel/react/view";

import {
  newTerminalPayload,
  parseTerminalPayload,
  terminalPanelKey,
  type TerminalPayload,
} from "./terminal-payload";
import { createTerminalSession, type TerminalSession } from "./terminal-session";

import "@xterm/xterm/css/xterm.css";

type TerminalExtra = {
  readonly session: TerminalSession;
};

type TerminalInstance = PanelInstance<TerminalPayload, TerminalExtra>;

export const terminalPanel = definePanelFamily({
  type: "terminal",
  key: terminalPanelKey,
  label: (payload) => payload.title,
  title: "Terminal",
  newPayload: newTerminalPayload,
  parse: parseTerminalPayload,
  create: (handle) => {
    const session = createTerminalSession(handle);
    return {
      session,
      reopen: () => session.focus(),
      dispose: () => session.dispose(),
    };
  },
  view: {
    icon: TerminalIcon,
    render: (instance) => <TerminalPanelView instance={instance} />,
  },
});

function TerminalPanelView({ instance }: { instance: TerminalInstance }) {
  const { orpcClient } = useRouteContext({ from: "__root__" });
  const hostRef = useRef<HTMLDivElement>(null);
  const snapshot = useSyncExternalStore(
    instance.session.subscribe,
    instance.session.getSnapshot,
    instance.session.getSnapshot,
  );

  useEffect(() => {
    const node = hostRef.current;
    if (node === null) return;
    instance.session.attach(node, orpcClient);
    // xterm's DOM host has to ride this view's mount; the PTY and Terminal
    // objects live on the panel instance and survive unmount.
    return () => instance.session.detach();
  }, [instance, orpcClient]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {snapshot.status === "starting" ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Spinner className="text-muted-foreground size-4" />
        </div>
      ) : null}
      {snapshot.status === "error" ? (
        <Empty className="absolute inset-0 z-10 py-8 md:py-8">
          <EmptyMedia variant="icon">
            <TerminalIcon />
          </EmptyMedia>
          <EmptyContent>
            <EmptyTitle>Unable to start terminal</EmptyTitle>
            <EmptyDescription>
              {snapshot.error ?? "The shell could not be created."}
            </EmptyDescription>
          </EmptyContent>
        </Empty>
      ) : null}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}
