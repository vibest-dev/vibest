import { FileCodeIcon } from "lucide-react";

import { asRecord, type PanelHandle } from "../core/panel";
import { definePanelFamily } from "../react/view";

export interface FilePayload {
  readonly path: string;
  /** Where a jump-to-line request last pointed. Part of the payload so it survives a reload. */
  readonly line?: number;
}

// Placeholder content — see ./README.md.
const MOCK_FILES = [
  "packages/server/src/harness/session.ts",
  "apps/app/src/features/chat/chat.tsx",
  "packages/contract/src/domain.ts",
];

const mockSource = (path: string): string[] =>
  Array.from({ length: 24 }, (_, index) => `// ${path}:${index + 1}`);

let nextMockFile = 0;

/**
 * A family with no `create`: every open path is its own tab, but nothing about
 * one needs state beyond the payload. `newPayload` is only here so the "+"
 * menu has something to open — a real file panel would be opened with a path
 * from a picker, a diff row, or a link in the transcript, and would omit it.
 */
export const filePanel = definePanelFamily({
  type: "file",
  key: (payload: FilePayload) => payload.path,
  label: (payload) => payload.path.slice(payload.path.lastIndexOf("/") + 1),
  title: "File",
  newPayload: () => ({ path: MOCK_FILES[nextMockFile++ % MOCK_FILES.length]! }),
  parse: (raw) => {
    const { path, line } = asRecord(raw) ?? {};
    if (typeof path !== "string") return null;
    return typeof line === "number" ? { path, line } : { path };
  },
  view: {
    icon: FileCodeIcon,
    render: (instance) => <FilePanelView instance={instance} />,
  },
});

function FilePanelView({ instance }: { instance: PanelHandle<FilePayload> }) {
  const { path, line } = instance.payload;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-muted-foreground shrink-0 border-b px-3 py-1.5 text-xs">{path}</div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {mockSource(path).map((text, index) => (
          <div key={text} className={index + 1 === line ? "bg-primary/10 -mx-3 px-3" : undefined}>
            <span className="text-muted-foreground/60 me-3 inline-block w-6 text-end">
              {index + 1}
            </span>
            {text}
          </div>
        ))}
      </pre>
    </div>
  );
}
