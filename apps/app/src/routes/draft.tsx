import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
import type { ListSessionsOutput, SessionSummary } from "@vibest/contract";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Button } from "@vibest/ui/components/button";
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
import { PermissionModeSelect } from "@/components/chat/permission-mode-select";
import Loader from "@/components/loader";
import { ImportProjectDialog } from "@/components/projects/import-project-dialog";
import { ProjectSelect } from "@/components/projects/project-select";
import type { ChatModel, ChatPermissionMode } from "@/core/chat/chat-config";
import { useChatManager } from "@/core/chat/chat-context";

// "/draft" is the new-session surface: pick a project, type a first message,
// which creates a session, sends it as the opening turn, and navigates into the
// live session.
// Keep the "/draft" path literal — the router plugin requires a string literal
// (autoCodeSplitting breaks otherwise).
export const Route = createFileRoute("/draft")({
  // The only search state: which project a sidebar `+` preselected. Absent means
  // nothing is selected yet — there is no default project.
  validateSearch: (search: Record<string, unknown>): { projectId?: string } =>
    typeof search.projectId === "string" ? { projectId: search.projectId } : {},
  component: DraftRoute,
});

function DraftRoute() {
  const { orpcQueryUtils } = Route.useRouteContext();
  const { projectId } = Route.useSearch();
  const manager = useChatManager();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [model, setModel] = useState<ChatModel>("sonnet");
  // Default to the most permissive mode (claude-code's "full" → bypassPermissions)
  // so first-run turns aren't gated on approvals; the user can dial it down.
  const [permissionMode, setPermissionMode] = useState<ChatPermissionMode>("full");
  const [importOpen, setImportOpen] = useState(false);

  const projects = useQuery({
    ...orpcQueryUtils.project.list.queryOptions(),
    staleTime: Infinity,
  });

  // Derived, never synced: a projectId the URL still carries but the server no
  // longer knows reads as "nothing selected", not as a stale selection.
  const selected = projects.data?.find((project) => project.id === projectId) ?? null;

  // Create the session and start its first turn against the manager's persisted
  // store, then navigate — the session route re-attaches the same Chat with the
  // turn already streaming.
  const startSession = useMutation({
    mutationFn: async ({ text }: { text: string }) => {
      if (!selected) throw new Error("No project selected");
      const ref = await orpcQueryUtils.session.create.call({
        projectId: selected.id,
        harnessAgentId: "claude-code",
        model,
        permissionMode,
      });
      void manager.attach(ref).prompt(text);
      return ref;
    },
    onSuccess: (ref, { text }) => {
      // Use the `queryOptions` key (it carries `type: "query"`), not the bare
      // `.key({ input })` — the latter omits `type` and setQueryData would write
      // a phantom entry the sidebar never reads.
      const listKey = orpcQueryUtils.session.list.queryOptions({
        input: { projectId: ref.projectId },
      }).queryKey;

      // Optimistic title: seed the row with the prompt text so it appears named
      // the instant we navigate. The server owns the durable title — it stamps a
      // whitespace-collapsed, length-clamped version from this same first prompt
      // and emits `session.updated`, which SessionEventsSync patches over this
      // row. So this is the real value, reconciled in place, never a placeholder
      // that flashes "New chat".
      queryClient.setQueryData<ListSessionsOutput>(listKey, (prev) => {
        if (prev?.some((session) => session.sessionId === ref.sessionId)) return prev;
        const optimistic: SessionSummary = {
          projectId: ref.projectId,
          harnessAgentId: ref.harnessAgentId,
          sessionId: ref.sessionId,
          title: text,
          // Placeholder ordering key (≈ now); the real createdAt loads on reload.
          createdAt: new Date().toISOString(),
          historyAvailable: true,
        };
        return [...(prev ?? []), optimistic];
      });

      navigate({ to: "/session/$sessionId", params: { sessionId: ref.sessionId } });
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
      // Enter with no project is a persistent blocker, not a transient one —
      // say so, or keyboard users get a silent no-op with no idea why.
      if (!selected) {
        toast.error("Pick a project before sending.");
        return false;
      }
      // A create already in flight: don't fire a second one.
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

  // Every branch below renders instead of the composer, because a composer that
  // can never submit is worse than saying why. `data === undefined` must be
  // handled explicitly: it covers both the first load and an outright failure,
  // and neither is "zero projects".
  if (projects.isPending) {
    return <Loader />;
  }

  if (projects.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          Couldn&apos;t load your projects: {projects.error.message}
        </p>
        <Button onClick={() => void projects.refetch()} size="sm" variant="outline">
          Retry
        </Button>
      </div>
    );
  }

  // Nothing to open a session against yet — send the user to the import flow
  // rather than showing a composer that can't submit.
  if (projects.data.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <p className="text-muted-foreground text-sm">Import a project to start a session.</p>
        <Button onClick={() => setImportOpen(true)} size="sm">
          Import project
        </Button>
        {importOpen && (
          <ImportProjectDialog
            // The first project is the only one there is — land on a composer
            // the user can actually submit instead of making them pick it.
            onClose={() => setImportOpen(false)}
            onImported={(project) =>
              navigate({ to: "/draft", search: { projectId: project.id }, replace: true })
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <ProjectSelect
          onChange={(next) =>
            navigate({ to: "/draft", search: { projectId: next }, replace: true })
          }
          projects={projects.data}
          value={selected?.id ?? null}
        />
        <PromptInput
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
                <PermissionModeSelect
                  harnessAgentId="claude-code"
                  value={permissionMode}
                  onChange={setPermissionMode}
                />
              </PromptInputTools>
              <PromptInputSubmit disabled={!hasContent || !selected || startSession.isPending} />
            </PromptInputToolbar>
          </ChatInputProvider>
        </PromptInput>
      </div>
    </div>
  );
}
