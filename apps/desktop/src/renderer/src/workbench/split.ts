import { Part } from "./part";
import type { ViewState } from "./types";
import type { View } from "./view";
import type { Workbench } from "./workbench";

export class Split {
  id: string;
  parts: Map<string, Part> = new Map();
  activePart: Part | null = null;
  workbench: Workbench;

  constructor(id: string, workbench: Workbench) {
    this.id = id;
    this.workbench = workbench;
  }

  async setViewState(viewState: ViewState): Promise<View> {
    const partId = `part-${crypto.randomUUID().slice(0, 8)}`;
    const part = new Part(partId, this);
    this.parts.set(partId, part);

    try {
      await part.setViewState(viewState);
    } catch (error) {
      this.parts.delete(partId);
      throw error;
    }

    this.activePart = part;
    this.syncToStore();

    return part.view;
  }

  setActivePart(part: Part): void {
    if (!this.parts.has(part.id)) return;
    this.activePart = part;
    this.syncToStore();
  }

  async closePart(part: Part): Promise<void> {
    if (!this.parts.has(part.id)) return;

    if (part.view) {
      try {
        await part.view.onClose();
      } catch {
        // best-effort cleanup
      }
    }
    this.parts.delete(part.id);

    // Select adjacent part
    if (this.activePart?.id === part.id) {
      const remaining = Array.from(this.parts.values());
      this.activePart = remaining[remaining.length - 1] ?? null;
    }

    this.syncToStore();
  }

  async closeAll(opts?: { skipSync?: boolean }): Promise<void> {
    const parts = Array.from(this.parts.values());
    for (const part of parts) {
      if (part.view) {
        try {
          await part.view.onClose();
        } catch {
          // catch-and-continue
        }
      }
    }
    this.parts.clear();
    this.activePart = null;
    if (!opts?.skipSync) {
      this.syncToStore();
    }
  }

  findView(viewState: ViewState): Part | null {
    for (const part of this.parts.values()) {
      if (part.view.getViewType() === viewState.type) {
        return part;
      }
    }
    return null;
  }

  private syncToStore(): void {
    this.workbench.syncToStore();
  }
}
