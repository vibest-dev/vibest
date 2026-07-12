import { cn } from "@vibest/ui/lib/utils";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Long user messages clamp to 9 lines with a fade-out mask and an expand
// toggle; short ones render untouched (overflow measured via scrollHeight).
export function CollapsibleUserText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setClamped(el.scrollHeight > el.clientHeight);
  }, [text]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div>
      <p
        ref={ref}
        style={
          !expanded && clamped
            ? { maskImage: "linear-gradient(to bottom, black 60%, transparent 100%)" }
            : undefined
        }
        className={cn("m-0 break-words whitespace-pre-wrap", !expanded && "line-clamp-[9]")}
      >
        {text}
      </p>
      {clamped && (
        <span
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(e) => e.key === "Enter" && toggle()}
          className="text-primary/70 hover:text-primary mt-0.5 inline-block cursor-pointer text-xs transition-colors select-none"
        >
          {expanded ? "Show less" : "Show more"}
        </span>
      )}
    </div>
  );
}
