import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { useState } from "react";
import { toast } from "sonner";

import { ChatInput } from "@/components/chat/input/chat-input";
import {
  ChatInputProvider,
  useChatInputController,
} from "@/components/chat/input/chat-input-provider";
import { createChatBaseExtensions } from "@/components/chat/input/extensions/chat-base-extensions";
import { createSubmitKeymap } from "@/components/chat/input/extensions/keymaps";
import { hasChatContent } from "@/components/chat/input/serialize";
import { ModelSelect } from "@/components/chat/model-select";
import { useChatManager } from "@/core/chat/chat-context";
import type { ChatModel } from "@/core/chat/chat-transport";

// "/draft" is the new-session surface: type a first message, which creates a
// session, sends it as the opening turn, and navigates into the live session.
// Keep the "/draft" path literal — the router plugin requires a string literal
// (autoCodeSplitting breaks otherwise).
export const Route = createFileRoute("/draft")({
  component: DraftRoute,
});

function DraftRoute() {
  const { orpcQueryUtils } = Route.useRouteContext();
  const manager = useChatManager();
  const navigate = useNavigate();
  const [model, setModel] = useState<ChatModel>("sonnet");

  // Create the session and start its first turn against the manager's persisted
  // store, then navigate — the session route re-attaches the same Chat with the
  // turn already streaming.
  const startSession = useMutation({
    mutationFn: async ({ text }: { text: string }) => {
      // Bootstrap the session under the server's working-directory project until
      // real project selection lands (project.create dedups by path).
      const project = await orpcQueryUtils.project.create.call({ path: "." });
      const ref = await orpcQueryUtils.session.create.call({
        projectId: project.id,
        harnessAgentId: "claude-code",
      });
      void manager.attach(ref).prompt(text, { model });
      return ref.sessionId;
    },
    onSuccess: (sessionId) => {
      navigate({ to: "/session/$sessionId", params: { sessionId } });
    },
    onError: (error) => {
      toast.error(`Failed to start session: ${error.message}`);
    },
  });

  const controller = useChatInputController({
    // Order is a hard constraint: base extensions first, submit keymap last —
    // otherwise bare Enter is consumed by the default newline behavior before
    // the keymap ever sees it.
    extensions: (self) => [
      ...createChatBaseExtensions({ placeholder: () => "Ask Claude Code anything..." }),
      createSubmitKeymap({ onSubmit: () => void self.submit() }),
    ],
    onSubmit: (text) => {
      // Create in flight: don't fire a second one.
      if (startSession.isPending) return false;
      startSession.mutate({ text });
      // Never clear: on success we navigate away (editor unmounts); on failure
      // the text must survive so the user can retry.
      return false;
    },
  });

  const hasContent = useEditorState({
    editor: controller?.editor ?? null,
    selector: ({ editor }) => (editor ? hasChatContent(editor) : false),
  });

  return (
    <div className="flex h-full items-center justify-center p-4">
      <PromptInput
        className="w-full max-w-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          void controller?.submit();
        }}
      >
        <ChatInputProvider controller={controller}>
          <ChatInput />
          <PromptInputToolbar>
            <PromptInputTools>
              <ModelSelect value={model} onChange={setModel} />
            </PromptInputTools>
            <PromptInputSubmit disabled={!hasContent || startSession.isPending} />
          </PromptInputToolbar>
        </ChatInputProvider>
      </PromptInput>
    </div>
  );
}
