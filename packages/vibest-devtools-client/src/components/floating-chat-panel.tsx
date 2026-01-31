"use client";

import {
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { Button } from "@vibest/ui/components/button";
import { CircleXIcon, SquarePenIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { useToolbarContext } from "@/context/toolbar";
import { Chat } from "@/features/client/components/chat";
import { orpc } from "@/lib/orpc";

export function FloatingChat() {
  const { toolbarRef, sessionId, open, setOpen } = useToolbarContext();
  const [chatInstanceKey, setChatInstanceKey] = useState(0);

  const { refs, floatingStyles, context } = useFloating({
    open,
    strategy: "fixed",
    middleware: [offset({ mainAxis: 5, alignmentAxis: 4 }), flip(), shift({ padding: 10 })],
    whileElementsMounted: autoUpdate,
  });
  // Handles opening the floating element via the click event.
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context)]);

  useEffect(() => {
    if (open && toolbarRef?.current) refs.setReference(toolbarRef.current);
  }, [open, refs, toolbarRef]);

  const handleNewSession = async () => {
    try {
      // Abort current session to prevent leaks; multi-session not supported yet
      if (sessionId.current) {
        await orpc.claudeCode.session.abort({ sessionId: sessionId.current });
        sessionId.current = undefined;
      }

      const { sessionId: newSessionId } = await orpc.claudeCode.session.create();
      sessionId.current = newSessionId;
      setChatInstanceKey((prev) => prev + 1);
    } catch (error) {
      console.error("Failed to start a new session", error);
    }
  };

  return (
    <AnimatePresence mode="wait">
      {open && (
        <div
          ref={refs.setFloating}
          style={{
            ...floatingStyles,
            zIndex: 2147483647,
            height: 520,
            width: 380,
          }}
          {...getFloatingProps()}
        >
          <motion.div className="bg-popover text-popover-foreground flex h-full flex-col overflow-hidden rounded-3xl border shadow-lg">
            <div className="flex flex-shrink-0 items-center justify-between p-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close"
                  title="Close"
                  className="text-muted-foreground/70 size-7"
                  onClick={() => setOpen(false)}
                >
                  <CircleXIcon size={16} aria-hidden="true" />
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="New Session"
                  title="New Session"
                  className="text-muted-foreground/70 size-7"
                  onClick={handleNewSession}
                >
                  <SquarePenIcon size={16} aria-hidden="true" />
                </Button>
              </div>
            </div>

            <Chat key={chatInstanceKey} />
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
