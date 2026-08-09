import { type ReactNode, type RefCallback, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface RelocatablePortal {
  mount: RefCallback<HTMLDivElement>;
  portal: ReactNode;
}

/** Keep one React subtree mounted while moving its DOM host between layouts. */
export function useRelocatablePortal(
  children: ReactNode,
  options: { hostClassName: string; key: string },
): RelocatablePortal {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = options.hostClassName;
    return element;
  });
  const focusedDescendant = useRef<HTMLElement | null>(null);
  const mount = useCallback(
    (container: HTMLDivElement | null) => {
      if (container === null) {
        const activeElement = host.ownerDocument.activeElement;
        focusedDescendant.current =
          activeElement instanceof HTMLElement && host.contains(activeElement)
            ? activeElement
            : null;
        return;
      }
      container.append(host);
      focusedDescendant.current?.focus({ preventScroll: true });
      focusedDescendant.current = null;
    },
    [host],
  );

  return { mount, portal: createPortal(children, host, options.key) };
}
