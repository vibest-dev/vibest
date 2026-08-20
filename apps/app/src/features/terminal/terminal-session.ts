import type { VibestClient } from "@vibest/client";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type { PanelHandle } from "@/components/layout/content-panel/model/panel";

import type { TerminalPayload } from "./terminal-payload";
import { readTerminalTheme } from "./terminal-theme";

export type TerminalSessionStatus = "starting" | "ready" | "error";

export type TerminalSessionSnapshot = {
  readonly status: TerminalSessionStatus;
  readonly error?: string;
};

export type TerminalSession = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TerminalSessionSnapshot;
  readonly attach: (container: HTMLElement, client: VibestClient) => void;
  readonly detach: () => void;
  readonly dispose: () => void;
  readonly focus: () => void;
};

export function createTerminalSession(handle: PanelHandle<TerminalPayload>): TerminalSession {
  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";

  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "var(--font-mono), ui-monospace, monospace",
    theme: readTerminalTheme(),
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host);

  let client: VibestClient | undefined;
  let ptyId: string | undefined;
  let abort: AbortController | undefined;
  let started = false;
  let observer: ResizeObserver | undefined;
  let snapshot: TerminalSessionSnapshot = { status: "starting" };
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const setSnapshot = (next: TerminalSessionSnapshot): void => {
    snapshot = next;
    notify();
  };

  terminal.onData((data) => {
    if (client === undefined || ptyId === undefined) return;
    void client.pty.write({ ptyId, data }).catch(() => {
      // The shell may have exited between the keystroke and the RPC.
    });
  });
  terminal.onResize(({ cols, rows }) => {
    if (client === undefined || ptyId === undefined) return;
    void client.pty.resize({ ptyId, cols, rows }).catch(() => {
      // Same as write: a closed pty is not a UI failure.
    });
  });

  const start = async (next: VibestClient): Promise<void> => {
    if (started) return;
    started = true;
    client = next;
    try {
      const existing = handle.payload.ptyId;
      const reconnect =
        existing === undefined
          ? undefined
          : await next.pty.get({ ptyId: existing }).catch(() => undefined);
      const info =
        reconnect ??
        (await next.pty.create({
          projectId: handle.sessionRef.projectId,
          cols: terminal.cols,
          rows: terminal.rows,
        }));
      if (reconnect === undefined) {
        handle.setPayload((payload) => ({ ...payload, ptyId: info.ptyId, title: info.title }));
      }
      ptyId = info.ptyId;
      abort = new AbortController();
      setSnapshot({ status: "ready" });
      const stream = await next.pty.subscribe({ ptyId: info.ptyId }, { signal: abort.signal });
      for await (const event of stream) {
        if (event.type === "data") terminal.write(event.data);
        else terminal.write(`\r\n[Process exited with code ${event.exitCode}]\r\n`);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to start the terminal";
      setSnapshot({ status: "error", error: message });
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    attach: (container, next) => {
      container.append(host);
      observer?.disconnect();
      observer = new ResizeObserver(() => {
        if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
        fitAddon.fit();
      });
      observer.observe(host);
      fitAddon.fit();
      terminal.focus();
      void start(next);
    },
    detach: () => {
      observer?.disconnect();
      observer = undefined;
      host.remove();
    },
    dispose: () => {
      abort?.abort();
      observer?.disconnect();
      const id = ptyId ?? handle.payload.ptyId;
      if (client !== undefined && id !== undefined) {
        void client.pty.delete({ ptyId: id }).catch(() => {
          // Already gone after a server restart.
        });
      }
      terminal.dispose();
    },
    focus: () => terminal.focus(),
  };
}
