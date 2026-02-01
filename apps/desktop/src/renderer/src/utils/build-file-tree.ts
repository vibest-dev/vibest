import type { FileDiff } from "../types";

export interface FileTreeNode {
  path: string; // "src/components/auth.tsx" or "src/components"
  isDirectory: boolean;
  status?: FileDiff["status"]; // only for files
  fileIndex?: number; // only for files
  children: FileTreeNode[];
}

export function buildFileTree(files: FileDiff[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const filename = file.newFile?.filename ?? file.oldFile?.filename;
    if (!filename) continue;

    const parts = filename.split("/");
    let currentLevel = root;
    let currentPath = "";

    for (let j = 0; j < parts.length; j++) {
      const part = parts[j];
      const isLast = j === parts.length - 1;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      let existing = currentLevel.find((n) => n.path === currentPath);

      if (!existing) {
        existing = {
          path: currentPath,
          isDirectory: !isLast,
          children: [],
          ...(isLast ? { status: file.status, fileIndex: i } : {}),
        };
        currentLevel.push(existing);
      }

      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort: directories first, then alphabetically by name
  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        const nameA = a.path.split("/").pop() ?? "";
        const nameB = b.path.split("/").pop() ?? "";
        return nameA.localeCompare(nameB);
      })
      .map((node) => ({
        ...node,
        children: sortNodes(node.children),
      }));
  };

  return sortNodes(root);
}
