import { View } from "../view";

interface DiffViewState {
  file: {
    path: string;
    status: string;
    staged: boolean;
    insertions: number;
    deletions: number;
    size: number;
  };
  repoPath: string;
}

export class DiffView extends View {
  private file: DiffViewState["file"] | null = null;
  private repoPath = "";

  getViewType(): string {
    return "diff";
  }

  getDisplayText(): string {
    if (this.file) {
      const name = this.file.path.split("/").pop() ?? this.file.path;
      return `Diff: ${name}`;
    }
    return "Diff";
  }

  async setState(state: unknown): Promise<void> {
    const s = state as { file?: DiffViewState["file"]; repoPath?: string } | undefined;
    if (s?.file) {
      this.file = s.file;
    }
    if (s?.repoPath) {
      this.repoPath = s.repoPath;
    }
  }

  getState(): DiffViewState | Record<string, never> {
    if (!this.file) return {};
    return {
      file: this.file,
      repoPath: this.repoPath,
    };
  }
}
