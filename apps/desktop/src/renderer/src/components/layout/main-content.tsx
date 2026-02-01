import type { ReactNode } from "react";

interface MainContentProps {
  children: ReactNode;
  /** When true, removes padding for full-bleed content like terminals */
  fullBleed?: boolean;
}

export function MainContent({ children, fullBleed = false }: MainContentProps) {
  return (
    <main
      className={`bg-background flex-1 overflow-hidden ${fullBleed ? "" : "p-5 overflow-y-auto"}`}
    >
      {children}
    </main>
  );
}
