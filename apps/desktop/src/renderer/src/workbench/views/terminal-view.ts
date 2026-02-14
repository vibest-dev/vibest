import type { Client } from "../../lib/client";
import { View } from "../view";

interface TerminalViewState {
  worktreeId: string;
  worktreePath: string;
  terminalId: string;
}

export class TerminalView extends View {
  private terminalId: string | null = null;
  private worktreeId = "";
  private worktreePath = "";
  private client: Client;

  constructor(client: Client) {
    super();
    this.client = client;
  }

  getViewType(): string {
    return "terminal";
  }

  getDisplayText(): string {
    return "Terminal";
  }

  async setState(state: unknown): Promise<void> {
    const s = state as { worktreeId?: string; worktreePath?: string } | undefined;
    if (s?.worktreeId) {
      this.worktreeId = s.worktreeId;
    }
    if (s?.worktreePath) {
      this.worktreePath = s.worktreePath;
    }
  }

  async onOpen(): Promise<void> {
    const result = await this.client.terminal.create({
      worktreeId: this.worktreeId,
      cwd: this.worktreePath,
    });
    this.terminalId = result.id;
    // Sync to store so React can read terminalId
    this.part.parent.workbench.syncToStore();
  }

  async onClose(): Promise<void> {
    if (this.terminalId) {
      try {
        await this.client.terminal.close({ terminalId: this.terminalId });
      } catch {
        // terminal may already be gone
      }
    }
  }

  getState(): TerminalViewState {
    return {
      worktreeId: this.worktreeId,
      worktreePath: this.worktreePath,
      terminalId: this.terminalId ?? "",
    };
  }
}
