import { skipToken, useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Spinner } from "@vibest/ui/components/spinner";
import { FileCodeIcon } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

import { asRecord, type PanelHandle } from "@/components/layout/content-panel/core/panel";
import { useContentPanel } from "@/components/layout/content-panel/react/hooks";
import { definePanelFamily } from "@/components/layout/content-panel/react/view";

import { createFileNavigationTracker, type FileNavigationTracker } from "./file-navigation";
import { FilePreviewPane } from "./file-preview-pane";
import { FileState } from "./file-state";
import { FileWorkspaceLayout } from "./file-workspace-layout";
import { useSessionWorkspace } from "./use-session-workspace";
import { useWorkspaceTree } from "./use-workspace-tree";
import { WorkspaceTreePane } from "./workspace-tree-pane";

export interface FilePayload {
  readonly path: string;
  /** Where a jump-to-line request last pointed. Part of the payload so it survives a reload. */
  readonly line?: number;
}

const fileName = (path: string): string => path.split(/[\\/]/).at(-1) || path;

export const filePanel = definePanelFamily({
  type: "file",
  key: (payload: FilePayload) => payload.path,
  label: (payload) => fileName(payload.path),
  title: "File",
  parse: (raw) => {
    const { path, line } = asRecord(raw) ?? {};
    if (typeof path !== "string") return null;
    return typeof line === "number" ? { path, line } : { path };
  },
  create: () => {
    const navigation = createFileNavigationTracker();
    return {
      navigation,
      reopen: navigation.request,
      dispose: navigation.dispose,
    };
  },
  view: {
    icon: FileCodeIcon,
    render: (instance) => <FilePanelView instance={instance} />,
  },
});

type FilePanelHandle = PanelHandle<FilePayload> & {
  readonly navigation: FileNavigationTracker;
};

function FilePanelView({ instance }: { instance: FilePanelHandle }) {
  const { path, line } = instance.payload;
  const navigationRequest = useSyncExternalStore(
    instance.navigation.subscribe,
    instance.navigation.getSnapshot,
    instance.navigation.getSnapshot,
  );
  const workspace = useSessionWorkspace();
  const panel = useContentPanel();
  const cwd = workspace.data?.path;
  const tree = useWorkspaceTree(cwd);
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const file = useQuery({
    ...orpcQueryUtils.fs.readFileString.queryOptions({
      input: cwd === undefined ? skipToken : { cwd, path },
    }),
    refetchOnWindowFocus: "always",
    staleTime: Infinity,
  });
  const openFile = useCallback(
    (nextPath: string) => panel?.open(filePanel, { path: nextPath }),
    [panel],
  );

  if (workspace.isPending) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <Spinner className="text-muted-foreground size-4" />
      </div>
    );
  }

  if (workspace.isError) {
    return (
      <FileState title="Unable to load workspace" onRetry={() => void workspace.refetch()}>
        The project list could not be loaded.
      </FileState>
    );
  }

  if (!workspace.data || panel === null || cwd === undefined) {
    return (
      <FileState title="Workspace unavailable">
        This session no longer resolves to an imported project.
      </FileState>
    );
  }

  const refreshing = file.isFetching || tree.isFetching;
  const refresh = (): void => {
    void Promise.all([file.refetch(), tree.refetch()]);
  };
  const preview = (
    <FilePreviewPane
      file={file}
      line={line}
      navigationRequest={navigationRequest}
      onRefresh={refresh}
      path={path}
      refreshing={refreshing}
    />
  );
  const treePane = (
    <WorkspaceTreePane
      onOpenFile={openFile}
      onRefresh={refresh}
      refreshing={refreshing}
      sessionId={panel.sessionKey}
      tree={tree}
      workspaceName={workspace.data.name}
      workspacePath={workspace.data.path}
    />
  );

  return <FileWorkspaceLayout preview={preview} tree={treePane} treeLabel={path} />;
}
