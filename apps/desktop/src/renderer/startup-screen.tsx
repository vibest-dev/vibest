import type { ReactElement } from "react";

import "./startup-screen.css";

const VIBEST_V_ROWS = [
  "████    ████",
  "████    ████",
  "  ████████",
  "  ████████",
  "    ████",
  "    ████",
];

const VIBEST_V_COLUMNS = Array.from(
  { length: Math.max(...VIBEST_V_ROWS.map((row) => row.length)) },
  (_, columnIndex) => VIBEST_V_ROWS.map((row) => row[columnIndex] ?? " ").join("\n"),
);

export function StartupScreen(): ReactElement {
  return (
    <main
      className="bg-background fixed inset-0 z-40 grid place-items-center"
      aria-label="Starting Vibest"
    >
      <div className="vibest-startup-logo" aria-hidden="true">
        {VIBEST_V_COLUMNS.map((column, columnIndex) => (
          <pre
            key={`${columnIndex}-${column}`}
            style={{ animationDelay: `${80 + columnIndex * 60}ms` }}
          >
            {column}
          </pre>
        ))}
      </div>
    </main>
  );
}
