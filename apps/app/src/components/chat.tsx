import type { SessionRef } from "@vibest/contract";
import { cn } from "@vibest/ui/lib/utils";

import { ChatInputComposer } from "@/components/chat/chat-input-composer";
import { ChatModelSelect } from "@/components/chat/chat-model-select";
import { ChatPermissionModeSelect } from "@/components/chat/chat-permission-mode-select";
import { ChatReasoningEffortSelect } from "@/components/chat/chat-reasoning-effort-select";
import { ChatSessionProvider } from "@/components/chat/chat-session-provider";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { HarnessBadge } from "@/components/chat/harness-badge";

// Default assembly of the compositional chat pieces: ChatSessionProvider owns
// the session context; transcript, composer, and config slots compose as
// peers. Surfaces that need a custom layout can spread this out themselves.
export function Chat({ className, sessionRef }: { className?: string; sessionRef: SessionRef }) {
  return (
    <ChatSessionProvider sessionRef={sessionRef}>
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <ChatTranscript />
        <div className="mx-auto w-full max-w-4xl min-w-80 flex-shrink-0 p-2">
          <ChatInputComposer
            toolbar={
              <>
                {/* Same slot the draft surface puts the harness picker in, so
                    the toolbar reads the same before and after creation. */}
                <HarnessBadge />
                <ChatModelSelect />
                {/* Cascades from the model above: appears only when the
                    selected model declares reasoningEffort levels. */}
                <ChatReasoningEffortSelect />
                <ChatPermissionModeSelect />
              </>
            }
          />
        </div>
      </div>
    </ChatSessionProvider>
  );
}
