import { Badge } from "@vibest/ui/components/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@vibest/ui/components/collapsible";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useState } from "react";

import type { DiffFileInfo } from "../../types";
import type { FileTreeNode } from "../../utils/build-file-tree";

const statusVariants: Record<DiffFileInfo["status"], "warning" | "success" | "error" | "info"> = {
  modified: "warning",
  added: "success",
  deleted: "error",
  renamed: "info",
};

const statusLabels: Record<DiffFileInfo["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
};

interface DiffFileTreeProps {
  stagedFiles: FileTreeNode[];
  unstagedFiles: FileTreeNode[];
  stagedCount: number;
  unstagedCount: number;
  onFileClick: (fileIndex: number) => void;
  selectedPath?: string;
}

interface TreeNodeProps {
  node: FileTreeNode;
  level: number;
  onFileClick: (fileIndex: number) => void;
  selectedPath?: string;
}

function TreeNode({ node, level, onFileClick, selectedPath }: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(true);
  const paddingLeft = level * 12;
  const name = node.path.split("/").pop() ?? "";
  const isSelected = node.path === selectedPath;

  if (node.isDirectory) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger
          className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-2 py-1"
          style={{ paddingLeft }}
        >
          <ChevronRight
            className={`text-muted-foreground size-3.5 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          {isOpen ? (
            <FolderOpen className="text-muted-foreground size-4 shrink-0" />
          ) : (
            <Folder className="text-muted-foreground size-4 shrink-0" />
          )}
          <span className="truncate text-sm">{name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {node.children.map((child) => (
            <TreeNode key={child.path} node={child} level={level + 1} onFileClick={onFileClick} selectedPath={selectedPath} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded px-2 py-1 ${isSelected ? "bg-accent" : "hover:bg-accent/50"}`}
      style={{ paddingLeft: paddingLeft + 14 }}
      onClick={() => node.fileIndex !== undefined && onFileClick(node.fileIndex)}
    >
      <File className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left text-sm">{name}</span>
      {node.status && (
        <Badge variant={statusVariants[node.status]} size="sm" className="shrink-0">
          {statusLabels[node.status]}
        </Badge>
      )}
    </button>
  );
}

export function DiffFileTree({ stagedFiles, unstagedFiles, stagedCount, unstagedCount, onFileClick, selectedPath }: DiffFileTreeProps) {
  const hasStagedFiles = stagedCount > 0;
  const hasUnstagedFiles = unstagedCount > 0;

  return (
    <div className="flex flex-col gap-2 p-2">
      {hasStagedFiles && (
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-2 py-1 font-medium">
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
            <span className="text-sm">Staged Changes</span>
            <span className="text-muted-foreground ml-auto text-xs">{stagedCount}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {stagedFiles.map((node) => (
              <TreeNode key={node.path} node={node} level={1} onFileClick={onFileClick} selectedPath={selectedPath} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {hasUnstagedFiles && (
        <Collapsible defaultOpen>
          <CollapsibleTrigger className="hover:bg-accent/50 flex w-full items-center gap-1 rounded px-2 py-1 font-medium">
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0 transition-transform [[data-state=open]>&]:rotate-90" />
            <span className="text-sm">Unstaged Changes</span>
            <span className="text-muted-foreground ml-auto text-xs">{unstagedCount}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {unstagedFiles.map((node) => (
              <TreeNode key={node.path} node={node} level={1} onFileClick={onFileClick} selectedPath={selectedPath} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {!hasStagedFiles && !hasUnstagedFiles && (
        <p className="text-muted-foreground px-2 py-4 text-center text-sm">No changes</p>
      )}
    </div>
  );
}
