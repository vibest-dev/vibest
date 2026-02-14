import type { Split } from "./split";
import type { ViewState } from "./types";
import type { View } from "./view";

export class Part {
  id: string;
  view!: View;
  parent: Split;

  constructor(id: string, parent: Split) {
    this.id = id;
    this.parent = parent;
  }

  async setViewState(viewState: ViewState): Promise<void> {
    // Close old view if present
    if (this.view) {
      await this.view.onClose();
    }

    // Create new view and assign before onOpen so syncToStore can read it
    const view = this.parent.workbench.createView(viewState.type, this);
    this.view = view;

    try {
      await view.setState(viewState.state);
      await view.onOpen();
    } catch (error) {
      try {
        await view.onClose();
      } catch {
        // defensive cleanup — ignore errors
      }
      throw error;
    }
  }
}
