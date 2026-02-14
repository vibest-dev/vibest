import { useAppStore } from "../../stores/app-store";
import { TerminalRenderer } from "./terminal-renderer";

interface TerminalPartProps {
  partId: string;
  isVisible: boolean;
}

export function TerminalPart({ partId, isVisible }: TerminalPartProps) {
  const terminalId = useAppStore((s) => {
    const part = s.workbench.parts.find((p) => p.id === partId);
    return (part?.state as { terminalId?: string } | undefined)?.terminalId ?? null;
  });

  if (!terminalId) {
    return null;
  }

  return <TerminalRenderer terminalId={terminalId} isVisible={isVisible} />;
}
