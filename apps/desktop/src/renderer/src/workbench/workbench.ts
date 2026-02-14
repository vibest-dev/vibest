import { Split } from "./split";
import type { Part } from "./part";
import type { PartState, SplitState, WorkbenchState } from "./types";
import type { View } from "./view";

export interface WorkbenchDeps {
  setState: (partial: { workbench: WorkbenchState }) => void;
}

interface ViewRegistration {
  factory: (part: Part) => View;
  creatable: boolean;
}

export class Workbench {
  private viewRegistrations: Map<string, ViewRegistration> = new Map();
  private store: WorkbenchDeps | null = null;

  // Per-worktree split storage for persistence across task switches
  private splitsByWorktree: Map<string, Map<string, Split>> = new Map();
  private activeWorktreeId: string | null = null;

  registerView(
    type: string,
    factory: (part: Part) => View,
    opts: { creatable: boolean } = { creatable: true },
  ): void {
    this.viewRegistrations.set(type, { factory, creatable: opts.creatable });
  }

  setStore(store: WorkbenchDeps): void {
    this.store = store;
  }

  createView(type: string, part: Part): View {
    const registration = this.viewRegistrations.get(type);
    if (!registration) {
      throw new Error(`No view factory registered for type "${type}"`);
    }
    const view = registration.factory(part);
    view.part = part;
    return view;
  }

  /** Get the active splits map for the current worktree. */
  private get splits(): Map<string, Split> {
    if (!this.activeWorktreeId) return new Map();
    let splits = this.splitsByWorktree.get(this.activeWorktreeId);
    if (!splits) {
      splits = new Map();
      this.splitsByWorktree.set(this.activeWorktreeId, splits);
    }
    return splits;
  }

  /**
   * Switch to a different worktree context.
   * Splits from the previous worktree are preserved in memory.
   */
  switchWorktree(worktreeId: string | null): void {
    if (this.activeWorktreeId === worktreeId) return;
    this.activeWorktreeId = worktreeId;
    this.syncToStore();
  }

  getActiveWorktreeId(): string | null {
    return this.activeWorktreeId;
  }

  getSplit(id: string): Split | null {
    return this.splits.get(id) ?? null;
  }

  createSplit(id: string): Split {
    const existing = this.splits.get(id);
    if (existing) return existing;

    const split = new Split(id, this);
    this.splits.set(id, split);
    this.syncToStore();
    return split;
  }

  async closeSplit(id: string): Promise<void> {
    const split = this.splits.get(id);
    if (!split) return;

    await split.closeAll({ skipSync: true });
    this.splits.delete(id);
    this.syncToStore();
  }

  /** Close all splits for the current worktree only. */
  async closeAll(): Promise<void> {
    const splits = Array.from(this.splits.values());
    for (const split of splits) {
      try {
        await split.closeAll({ skipSync: true });
      } catch {
        // catch-and-continue
      }
    }
    this.splits.clear();
    this.syncToStore();
  }

  /** Close all splits for a specific worktree and remove it from the cache. */
  async closeWorktree(worktreeId: string): Promise<void> {
    const splits = this.splitsByWorktree.get(worktreeId);
    if (!splits) return;

    for (const split of splits.values()) {
      try {
        await split.closeAll({ skipSync: true });
      } catch {
        // catch-and-continue
      }
    }
    this.splitsByWorktree.delete(worktreeId);

    if (this.activeWorktreeId === worktreeId) {
      this.activeWorktreeId = null;
      this.syncToStore();
    }
  }

  creatableTypes(): string[] {
    const types: string[] = [];
    for (const [viewType, reg] of this.viewRegistrations) {
      if (reg.creatable) {
        types.push(viewType);
      }
    }
    return types;
  }

  syncToStore(): void {
    if (!this.store) return;

    const splits: SplitState[] = [];
    const parts: PartState[] = [];

    for (const split of this.splits.values()) {
      const partIds: string[] = [];
      for (const part of split.parts.values()) {
        partIds.push(part.id);
        parts.push({
          id: part.id,
          viewType: part.view.getViewType(),
          title: part.view.getDisplayText(),
          state: part.view.getState(),
        });
      }
      splits.push({
        id: split.id,
        partIds,
        activePartId: split.activePart?.id ?? null,
      });
    }

    this.store.setState({
      workbench: { splits, parts },
    });
  }
}

export const workbench = new Workbench();
