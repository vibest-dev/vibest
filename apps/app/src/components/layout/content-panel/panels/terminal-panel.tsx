import { TerminalIcon } from "lucide-react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import { asRecord, type PanelInstance } from "../core/panel";
import { definePanelFamily } from "../react/view";

interface TerminalPayload {
  readonly terminalId: string;
  /**
   * Shown on the tab. In the payload rather than the instance because the tab
   * strip labels a panel it has never activated — and a reload has to redraw
   * that strip before any instance exists.
   */
  readonly title: string;
}

interface TerminalState {
  readonly lines: readonly string[];
}

/**
 * The scrollback lives here and nowhere else — not in the panel store, which
 * persists, and not in the view, which unmounts. This is the shape t3code got
 * wrong: it kept per-terminal state in the panel store, which forced that store
 * to grow terminal-specific methods and made it the one thing standing between
 * "add a panel type" and "touch eleven places". An instance gives it a home the
 * host cannot see.
 */
interface TerminalExtra {
  readonly store: StoreApi<TerminalState>;
  run(command: string): void;
  dispose(): void;
}

type TerminalInstance = PanelInstance<TerminalPayload, TerminalExtra>;

let nextTerminal = 0;

// Placeholder content — see ./README.md.
const GREETING = ["$ pnpm dev", "  VITE ready in 412 ms", "  ➜  Local: http://localhost:5173/"];

export const terminalPanel = definePanelFamily({
  type: "terminal",
  key: (payload: TerminalPayload) => payload.terminalId,
  label: (payload) => payload.title,
  title: "Terminal",
  newPayload: () => {
    const n = ++nextTerminal;
    return { terminalId: `terminal-${n}`, title: `zsh ${n}` };
  },
  parse: (raw) => {
    const { terminalId, title } = asRecord(raw) ?? {};
    if (typeof terminalId !== "string") return null;
    return { terminalId, title: typeof title === "string" ? title : "Terminal" };
  },
  create: () => {
    const store = createStore<TerminalState>(() => ({ lines: GREETING }));
    return {
      store,
      // Annotated: `Extra` is inferred *from* this literal, so nothing
      // contextually types the parameter yet.
      run: (command: string) =>
        store.setState((state) => ({
          lines: [...state.lines, `$ ${command}`, `  ${command}: command not found`],
        })),
      // Closing the tab is what kills the shell — unmounting is not. Navigating
      // away unmounts and must leave it running.
      dispose: () => store.setState({ lines: [] }),
    };
  },
  view: {
    icon: TerminalIcon,
    render: (instance) => <TerminalPanelView instance={instance} />,
  },
});

function TerminalPanelView({ instance }: { instance: TerminalInstance }) {
  const lines = useStore(instance.store, (state) => state.lines);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <pre className="bg-muted/20 min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines.join("\n")}
      </pre>
      <form
        className="shrink-0 border-t"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("command");
          if (!(input instanceof HTMLInputElement) || input.value === "") return;
          instance.run(input.value);
          input.value = "";
        }}
      >
        <input
          name="command"
          aria-label={`${instance.payload.title} input`}
          placeholder="Type a command…"
          autoComplete="off"
          className="placeholder:text-muted-foreground/60 w-full bg-transparent px-3 py-2 font-mono text-xs outline-none"
        />
      </form>
    </div>
  );
}
