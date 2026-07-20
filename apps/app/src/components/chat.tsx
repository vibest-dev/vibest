import type { SessionRef } from "@vibest/contract";
import { cn } from "@vibest/ui/lib/utils";

import { ChatInputComposer } from "@/components/chat/chat-input-composer";
import { ChatModelSelect } from "@/components/chat/chat-model-select";
import { ChatPermissionModeSelect } from "@/components/chat/chat-permission-mode-select";
import { ChatSessionProvider } from "@/components/chat/chat-session-context";
import { ChatTranscript } from "@/components/chat/chat-transcript";

// Default assembly of the compositional chat pieces: ChatSessionProvider owns
// the session context; transcript, composer, and config slots compose as
// peers. Surfaces that need a custom layout can spread this out themselves.
export function Chat({ className, sessionRef }: { className?: string; sessionRef: SessionRef }) {
  return (
    <ChatSessionProvider sessionRef={sessionRef}>
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <ChatTranscript />
        <div className="flex-shrink-0 p-2">
          <ChatInputComposer
            toolbar={
              <>
                <ChatModelSelect />
                <ChatPermissionModeSelect />
              </>
            }
          />
        </div>
      </div>
    </ChatSessionProvider>
  );
}
