import type { SessionRef } from "@vibest/contract";
import { cn } from "@vibest/ui/lib/utils";

import { ChatHarnessIcon } from "@/features/chat/components/chat-harness-icon";
import { ChatInputComposer } from "@/features/chat/components/chat-input-composer";
import { ChatModelSelect } from "@/features/chat/components/chat-model-select";
import { ChatPermissionModeSelect } from "@/features/chat/components/chat-permission-mode-select";
import { ChatReasoningEffortSelect } from "@/features/chat/components/chat-reasoning-effort-select";
import { ChatSessionProvider } from "@/features/chat/components/chat-session-provider";
import { ChatTranscript } from "@/features/chat/components/chat-transcript";

// Default assembly of the compositional chat pieces: ChatSessionProvider owns
// the session context; transcript, composer, and config slots compose as
// peers. Surfaces that need a custom layout can spread this out themselves.
export function Chat({
  className,
  sessionRef,
  cwd,
}: {
  className?: string;
  sessionRef: SessionRef;
  /**
   * The session's working directory. Resolved by the route, not here: that
   * lookup belongs to the projects feature, and features don't reach sideways.
   * Undefined until the project list lands, which only delays the model probe.
   */
  cwd: string | undefined;
}) {
  return (
    <ChatSessionProvider cwd={cwd} sessionRef={sessionRef}>
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <ChatTranscript />
        <div className="mx-auto w-full max-w-4xl min-w-80 flex-shrink-0 p-2">
          <ChatInputComposer
            toolbar={
              <>
                {/* Same slot the draft surface puts the harness picker in, so
                    the toolbar keeps its shape across creation — the picker
                    collapses to its icon once the choice is settled. */}
                <ChatHarnessIcon />
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
