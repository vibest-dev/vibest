import { client } from "../lib/client";
import { appStore } from "../stores/app-store";
import { DiffView } from "./views/diff-view";
import { TerminalView } from "./views/terminal-view";
import { workbench } from "./workbench";

export function initWorkbench(): void {
  // Connect workbench to the Zustand store
  workbench.setStore({
    setState: (partial) => appStore.setState(partial),
  });

  // Register view types
  workbench.registerView("terminal", () => new TerminalView(client), { creatable: true });
  workbench.registerView("diff", () => new DiffView(), { creatable: false });
}
