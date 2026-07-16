import { useAnimate } from "motion/react-mini";
import { useEffect, type ReactElement } from "react";

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

const EASE = [0.22, 1, 0.36, 1] as const;

export function StartupScreen(): ReactElement {
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reducedMotion) return;

    const animations = [
      animate(
        scope.current,
        { transform: ["scale(0.96)", "scale(1)"] },
        { duration: 0.32, ease: EASE },
      ),
      ...VIBEST_V_COLUMNS.map((_, columnIndex) =>
        animate(
          `[data-vibest-column="${columnIndex}"]`,
          {
            opacity: [0, 1],
            transform: ["translateX(-4px)", "translateX(0)"],
          },
          {
            delay: 0.02 + columnIndex * 0.022,
            duration: 0.18,
            ease: EASE,
          },
        ),
      ),
    ];

    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [animate, reducedMotion, scope]);

  return (
    <main
      className="bg-background fixed inset-0 z-40 grid place-items-center"
      aria-label="Starting Vibest"
    >
      <div ref={scope} className="vibest-startup-logo" aria-hidden="true">
        {VIBEST_V_COLUMNS.map((column, columnIndex) => (
          <pre key={`${columnIndex}-${column}`} data-vibest-column={columnIndex}>
            {column}
          </pre>
        ))}
      </div>
    </main>
  );
}
