import { FileTree, prepareFileTreeInput } from "@pierre/trees";
import type { WorkspaceTreeEntry } from "@vibest/contract/fs";

export interface SessionFileTree {
  readonly model: FileTree;
  entries: ReadonlyArray<WorkspaceTreeEntry>;
  entryByPath: ReadonlyMap<string, WorkspaceTreeEntry>;
  directoryPaths: ReadonlySet<string>;
}

const sessionTrees = new Map<string, SessionFileTree>();

export function toPierrePath(entry: WorkspaceTreeEntry): string {
  return entry.type === "directory" ? `${entry.path}/` : entry.path;
}

export function symlinkDescription(entry: WorkspaceTreeEntry): string | null {
  if (entry.type !== "symlink") return null;
  switch (entry.symlinkTarget) {
    case "file":
      return "Symbolic link to a file";
    case "directory":
      return "Symbolic link to a directory; opening and expansion are disabled";
    case "outside":
      return "Symbolic link outside the workspace; opening is disabled";
    case "broken":
      return "Broken symbolic link; opening is disabled";
    case "other":
      return "Symbolic link to an unsupported filesystem entry; opening is disabled";
    default:
      return "Symbolic link with an unknown target";
  }
}

function createSessionFileTree(): SessionFileTree {
  let state: SessionFileTree;
  const model = new FileTree({
    paths: [],
    initialExpansion: "closed",
    flattenEmptyDirectories: true,
    stickyFolders: true,
    renderRowDecoration: ({ item }) => {
      const entry = state.entryByPath.get(item.path);
      const title = entry === undefined ? null : symlinkDescription(entry);
      return title === null ? null : { text: "↗", title };
    },
  });
  state = {
    model,
    entries: [],
    entryByPath: new Map(),
    directoryPaths: new Set(),
  };
  return state;
}

export function getSessionFileTree(sessionId: string): SessionFileTree {
  const existing = sessionTrees.get(sessionId);
  if (existing !== undefined) return existing;
  const created = createSessionFileTree();
  sessionTrees.set(sessionId, created);
  return created;
}

export function syncSessionFileTree(
  state: SessionFileTree,
  entries: ReadonlyArray<WorkspaceTreeEntry>,
): void {
  if (state.entries === entries) return;

  const expandedPaths: string[] = [];
  for (const directoryPath of state.directoryPaths) {
    const item = state.model.getItem(directoryPath);
    if (item !== null && item.isDirectory() && "isExpanded" in item && item.isExpanded()) {
      expandedPaths.push(directoryPath);
    }
  }

  const paths: string[] = [];
  const nextDirectoryPaths = new Set<string>();
  const entryByPath = new Map<string, WorkspaceTreeEntry>();
  for (const entry of entries) {
    const pierrePath = toPierrePath(entry);
    paths.push(pierrePath);
    if (entry.type === "directory") nextDirectoryPaths.add(pierrePath);
    entryByPath.set(entry.path, entry);
  }
  const preparedInput = prepareFileTreeInput(paths);
  state.entries = entries;
  state.entryByPath = entryByPath;
  state.directoryPaths = nextDirectoryPaths;
  state.model.resetPaths({
    preparedInput,
    initialExpandedPaths: expandedPaths.filter((path) => nextDirectoryPaths.has(path)),
  });
}

export function isOpenableTreeEntry(entry: WorkspaceTreeEntry | undefined): boolean {
  return entry?.type === "file" || (entry?.type === "symlink" && entry.symlinkTarget === "file");
}

if (typeof window !== "undefined") {
  window.addEventListener(
    "beforeunload",
    () => {
      for (const state of sessionTrees.values()) state.model.cleanUp();
      sessionTrees.clear();
    },
    { once: true },
  );
}
