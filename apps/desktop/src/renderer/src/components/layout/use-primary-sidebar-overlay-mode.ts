import { useEffect, useState } from "react";

const NARROW_LAYOUT_BREAKPOINT = 1280;

export function usePrimarySidebarOverlayMode() {
  const [isPrimarySidebarOverlayMode, setIsPrimarySidebarOverlayMode] = useState<boolean>(() =>
    typeof window !== "undefined" ? window.innerWidth < NARROW_LAYOUT_BREAKPOINT : false,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(`(max-width: ${NARROW_LAYOUT_BREAKPOINT - 1}px)`);

    const handleChange = () => {
      setIsPrimarySidebarOverlayMode(window.innerWidth < NARROW_LAYOUT_BREAKPOINT);
    };

    handleChange();
    mediaQuery.addEventListener("change", handleChange);

    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  return isPrimarySidebarOverlayMode;
}
