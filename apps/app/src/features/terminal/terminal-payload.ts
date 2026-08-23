import { asRecord } from "@/components/layout/content-panel/model/panel";

export interface TerminalPayload {
  readonly terminalId: string;
  readonly title: string;
  readonly ptyId?: string;
}

export function parseTerminalPayload(raw: unknown): TerminalPayload | null {
  const record = asRecord(raw) ?? {};
  const { terminalId, title, ptyId } = record;
  if (typeof terminalId !== "string" || terminalId.length === 0) return null;
  return {
    terminalId,
    title: typeof title === "string" && title.length > 0 ? title : "Terminal",
    ...(typeof ptyId === "string" && ptyId.length > 0 ? { ptyId } : {}),
  };
}

export function terminalPanelKey(payload: TerminalPayload): string {
  return payload.terminalId;
}

export function newTerminalPayload(): TerminalPayload {
  return { terminalId: crypto.randomUUID(), title: "Terminal" };
}
