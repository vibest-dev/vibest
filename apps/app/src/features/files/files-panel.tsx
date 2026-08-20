import { Button } from "@vibest/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from "@vibest/ui/components/empty";
import { Spinner } from "@vibest/ui/components/spinner";
import { FilesIcon, FileTextIcon } from "lucide-react";
import { useCallback } from "react";

import type { PanelHandle } from "@/components/layout/content-panel/model/panel";
import { useContentPanel } from "@/components/layout/content-panel/react/hooks";
import { definePanel } from "@/components/layout/content-panel/react/view";

import { filePanel } from "./file-panel";
import { FileState } from "./file-state";
import { FileWorkspaceLayout } from "./file-workspace-layout";
import { useSessionWorkspace } from "./use-session-workspace";
import { useWorkspaceTree } from "./use-workspace-tree";
import { WorkspaceTreePane } from "./workspace-tree-pane";

export const filesPanel = definePanel({
  type: "files",
  label: "Files",
  view: {
    icon: FilesIcon,
    render: (instance) => <FilesPanelView instance={instance} />,
  },
});

function FilesPanelView({ instance }: { instance: PanelHandle<void> }) {
  const workspace = useSessionWorkspace();
  const panel = useContentPanel();
  const cwd = workspace.data?.path;
  const tree = useWorkspaceTree(cwd);
  const openFile = useCallback(
    (path: string) => {
      if (panel === null) return;
      panel.replace(instance.id, filePanel, { path });
    },
    [instance, panel],
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
      <WorkspaceState title="Unable to load workspace" onRetry={() => void workspace.refetch()}>
        The project list could not be loaded.
      </WorkspaceState>
    );
  }

  if (!workspace.data || panel === null) {
    return (
      <WorkspaceState title="Workspace unavailable">
        This session no longer resolves to an imported project.
      </WorkspaceState>
    );
  }

  const treePane = (
    <WorkspaceTreePane
      onOpenFile={openFile}
      sessionId={panel.sessionKey}
      tree={tree}
      workspaceName={workspace.data.name}
      workspacePath={workspace.data.path}
    />
  );

  return (
    <FileWorkspaceLayout
      preview={
        <FileState icon={FileTextIcon} prominentIcon title="打开文件">
          从工作区目录树中选择文件
        </FileState>
      }
      tree={treePane}
      treeLabel={workspace.data.name}
    />
  );
}

function WorkspaceState({
  title,
  children,
  onRetry,
}: {
  title: string;
  children: string;
  onRetry?: () => void;
}) {
  return (
    <Empty className="py-8 md:py-8">
      <EmptyMedia variant="icon">
        <FilesIcon />
      </EmptyMedia>
      <EmptyContent>
        <div>
          <EmptyTitle className="text-base">{title}</EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </div>
        {onRetry ? (
          <Button onClick={onRetry} size="sm" variant="outline">
            Try again
          </Button>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}
