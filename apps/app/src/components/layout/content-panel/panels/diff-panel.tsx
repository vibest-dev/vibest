import { FileDiffIcon } from "lucide-react";

import { definePanel } from "../react/view";

// Placeholder content — see ./README.md.
const MOCK_FILES = [
  { path: "packages/server/src/harness/session.ts", added: 24, removed: 6 },
  { path: "apps/app/src/features/chat/chat.tsx", added: 8, removed: 8 },
  { path: "packages/contract/src/domain.ts", added: 3, removed: 0 },
];

const MOCK_HUNK = [
  { sign: " ", text: "  const session = yield* manager.sessionFor(ref)" },
  { sign: "-", text: "  return session.snapshot()" },
  { sign: "+", text: "  const snapshot = session.snapshot()" },
  { sign: "+", text: "  yield* bus.publish(sessionUpdated(ref, snapshot))" },
  { sign: "+", text: "  return snapshot" },
  { sign: " ", text: "}" },
];

/**
 * A singleton with no `create`: the default handle is everything it needs. The
 * whole definition is data plus one render function.
 */
export const diffPanel = definePanel({
  type: "diff",
  label: "Diff",
  view: {
    icon: FileDiffIcon,
    render: () => <DiffPanelView />,
  },
});

function DiffPanelView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ul className="shrink-0 border-b py-1">
        {MOCK_FILES.map((file) => (
          <li
            key={file.path}
            className="hover:bg-accent/60 flex items-center gap-2 px-3 py-1 text-xs"
          >
            <span className="text-muted-foreground truncate">{file.path}</span>
            <span className="ms-auto shrink-0 font-mono text-[11px]">
              <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>{" "}
              <span className="text-rose-600 dark:text-rose-400">−{file.removed}</span>
            </span>
          </li>
        ))}
      </ul>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {MOCK_HUNK.map((line, index) => (
          <div
            key={index}
            className={
              line.sign === "+"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : line.sign === "-"
                  ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                  : "text-muted-foreground"
            }
          >
            {line.sign}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
