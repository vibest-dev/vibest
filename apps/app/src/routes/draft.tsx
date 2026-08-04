import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
import type { ListSessionsOutput, SessionSummary } from "@vibest/contract";
import {
  HARNESS_AGENT_IDS,
  PermissionModeSchema,
  type HarnessAgentId,
  type PermissionMode,
} from "@vibest/contract";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Button } from "@vibest/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vibest/ui/components/empty";
import { FolderPlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import Loader from "@/components/loader";
import { HarnessSelect } from "@/features/chat/components/harness-select";
import { ChatInput } from "@/features/chat/components/input/chat-input";
import { ChatInputProvider } from "@/features/chat/components/input/chat-input-provider";
import { createChatBaseExtensions } from "@/features/chat/components/input/extensions/chat-base-extensions";
import { createSubmitKeymap } from "@/features/chat/components/input/extensions/keymaps";
import { hasChatContent } from "@/features/chat/components/input/serialize";
import { useChatInputController } from "@/features/chat/components/input/use-chat-input-controller";
import { ModelSelect } from "@/features/chat/components/model-select";
import { PermissionModeSelect } from "@/features/chat/components/permission-mode-select";
import { orderPermissionModes } from "@/features/chat/harness/permission-modes";
import {
  pickDefaultHarnessAgentId,
  resolveModel,
  resolvePermissionMode,
} from "@/features/chat/harness/session-config";
import {
  useHarnessAgent,
  useHarnessAgents,
  useHarnessProbe,
} from "@/features/chat/harness/use-harness";
import { useChatManager } from "@/features/chat/runtime/chat-context";
import { ImportProjectDialog } from "@/features/projects/import-project-dialog";
import { ProjectSelect } from "@/features/projects/project-select";
import { useProject, useProjects } from "@/features/projects/use-projects";

// Until the user picks one. Every other config default is declared by the
// harness itself; which harness to start from is the one thing no harness can
// answer, so it is a product decision and lives here. It is a preference, not a
// guarantee — see pickDefaultHarnessAgentId for what happens when it isn't
// installed.
const PREFERRED_HARNESS_AGENT_ID: HarnessAgentId = "claude-code";

/**
 * The draft config lives in the URL, and only what the user explicitly picked
 * is written there. Everything absent follows the selected harness's declared
 * default, which is the same thing "omit the field" means to `session.create`.
 *
 * That is what makes switching harness free of reset logic: navigating with a
 * new `harness` simply drops the other params, so everything falls back to the
 * new harness's defaults. No effect, no state to synchronise, no frame where a
 * dropdown holds a value the new harness doesn't offer. `projectId` survives
 * the switch — it names what the session is about, not how it runs.
 *
 * A model is two params (`provider` + `model`) that only mean anything
 * together — modelId alone is only unique within its provider.
 */
type DraftSearch = {
  readonly projectId?: string;
  readonly harness?: HarnessAgentId;
  readonly provider?: string;
  readonly model?: string;
  readonly permission?: PermissionMode;
};

const asHarnessAgentId = (value: unknown): HarnessAgentId | undefined =>
  HARNESS_AGENT_IDS.find((id) => id === value);

const asPermissionMode = (value: unknown): PermissionMode | undefined =>
  PermissionModeSchema.literals.find((mode) => mode === value);

const asText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const optional = <K extends string, V extends string>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

// "/draft" is the new-session surface: pick a project, type a first message,
// which creates a session, sends it as the opening turn, and navigates into the
// live session.
// Keep the "/draft" path literal — the router plugin requires a string literal
// (autoCodeSplitting breaks otherwise).
export const Route = createFileRoute("/draft")({
  validateSearch: (search: Record<string, unknown>): DraftSearch => ({
    ...optional("projectId", asText(search.projectId)),
    ...optional("harness", asHarnessAgentId(search.harness)),
    ...optional("provider", asText(search.provider)),
    ...optional("model", asText(search.model)),
    ...optional("permission", asPermissionMode(search.permission)),
  }),
  component: DraftRoute,
});

function DraftRoute() {
  const { orpcQueryUtils } = Route.useRouteContext();
  const search = Route.useSearch();
  const manager = useChatManager();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);

  const projects = useProjects();
  // Derived, never synced: a projectId the URL still carries but the server no
  // longer knows reads as "nothing selected", not as a stale selection.
  const selected = useProject(search.projectId) ?? null;

  const harnessAgents = useHarnessAgents();
  const harnessAgentId =
    search.harness ?? pickDefaultHarnessAgentId(harnessAgents, PREFERRED_HARNESS_AGENT_ID);
  const harnessAgent = useHarnessAgent(harnessAgentId);
  // The selected project's directory decides what its harness can offer — a
  // project's own settings can remap what a model id resolves to. No project
  // picked means no cwd to probe, so the model picker has nothing to offer;
  // the composer blocks on project selection anyway. Undefined until the probe
  // lands is not a wait either: submitting meanwhile omits `model` — which is
  // exactly what "the user didn't pick one" already means.
  const probe = useHarnessProbe(harnessAgentId, selected?.path);
  // Each dimension resolves on its own — a stale URL pick is dropped, an
  // absent one falls back to the declared default.
  const providers = probe.data?.providers ?? [];
  const model = resolveModel(providers, search.provider, search.model);
  const permissionModes = orderPermissionModes(harnessAgent?.permissionModes ?? []);
  const permissionMode = resolvePermissionMode(harnessAgent, search.permission);

  // Create the session and start its first turn against the manager's persisted
  // store, then navigate — the session route re-attaches the same Chat with the
  // turn already streaming.
  const startSession = useMutation({
    mutationFn: async ({ text }: { text: string }) => {
      if (!selected) throw new Error("No project selected");
      const ref = await orpcQueryUtils.session.create.call({
        projectId: selected.id,
        harnessAgentId,
        // Omitted when the harness declares no such dimension, which is how it
        // ends up using its own configured default.
        ...(model !== undefined ? { providerId: model.providerId, modelId: model.modelId } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
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
      // and emits `session.updated`, which useSessionListSync patches over this
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

      navigate({
        to: "/session/$sessionId",
        params: { sessionId: ref.sessionId },
        // We just created it, so the whole ref is in hand — pass it along.
        search: { projectId: ref.projectId, harness: ref.harnessAgentId },
      });
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
      ...createChatBaseExtensions({
        placeholder: () => `Ask ${harnessAgent?.name ?? "your agent"} anything...`,
      }),
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
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderPlusIcon aria-hidden="true" />
          </EmptyMedia>
          {/*
            The nested `h1` is deliberate: `EmptyTitle` is vendored from the coss
            registry (docs/adr/0001), renders a plain `div`, and takes no `render`
            prop — so this is the only way to keep both its `data-slot` styling
            hook and a real page heading. Don't flatten it.
          */}
          <EmptyTitle>
            <h1>Import your first project</h1>
          </EmptyTitle>
          <EmptyDescription>
            Choose a local folder for your coding agent to work in. You can start a chat right after
            importing.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => setImportOpen(true)}>Import project</Button>
        </EmptyContent>
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
      </Empty>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="flex w-full max-w-2xl flex-col gap-2">
        <ProjectSelect
          // Harness config survives a project switch — it says how the session
          // runs, not what it is about. A pick the new project's catalog doesn't
          // offer is dropped by the resolvers, not carried into the session.
          onChange={(next) =>
            navigate({
              to: "/draft",
              search: (prev) => ({ ...prev, projectId: next }),
              replace: true,
            })
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
              {/* Harness first: it decides what the other two can offer. */}
              <PromptInputTools>
                <HarnessSelect
                  value={harnessAgentId}
                  onChange={(next) =>
                    void navigate({
                      to: "/draft",
                      search: (prev) => ({
                        ...optional("projectId", prev.projectId),
                        harness: next,
                      }),
                    })
                  }
                />
                <ModelSelect
                  providers={providers}
                  providerId={model?.providerId}
                  modelId={model?.modelId}
                  onChange={(providerId, modelId) =>
                    void navigate({
                      to: "/draft",
                      search: (prev) => ({ ...prev, provider: providerId, model: modelId }),
                    })
                  }
                />
                <PermissionModeSelect
                  permissionModes={permissionModes}
                  value={permissionMode}
                  onChange={(permission) =>
                    void navigate({ to: "/draft", search: (prev) => ({ ...prev, permission }) })
                  }
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
