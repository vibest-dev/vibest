import { useSelector } from "@xstate/store/react";
import { useEffect } from "react";

import { inspectorStore } from "../store";
import { shouldIgnoreInspectorEvent } from "../util";

export function useInspectorEvents() {
  const inspectState = useSelector(inspectorStore, (state) => state.context.state);

  useEffect(() => {
    if (inspectState === "idle") return;

    const handlePointerMove = (event: PointerEvent) => {
      if (shouldIgnoreInspectorEvent(event)) return;
      inspectorStore.trigger.POINTER_MOVE({ event });
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (shouldIgnoreInspectorEvent(event)) return;
      inspectorStore.trigger.POINTER_DOWN({ event });
    };
    const handlePointerLeave = (event: PointerEvent) => {
      if (shouldIgnoreInspectorEvent(event)) return;
      inspectorStore.trigger.POINTER_LEAVE();
    };

    document.addEventListener("pointermove", handlePointerMove, {
      capture: true,
    });
    document.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
    });
    document.addEventListener("pointerleave", handlePointerLeave, {
      capture: true,
    });

    return () => {
      document.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      document.removeEventListener("pointerleave", handlePointerLeave, {
        capture: true,
      });
    };
  }, [inspectState]);
}
