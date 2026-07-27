import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEditorState } from "@tiptap/react";
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
import { toast } from "sonner";

import { HarnessSelect } from "@/components/chat/harness-select";
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
import { useChatManager } from "@/core/chat/chat-context";
import { orderPermissionModes } from "@/core/harness/permission-modes";
import {
  pickDefaultHarnessAgentId,
  resolveModel,
  resolvePermissionMode,
} from "@/core/harness/session-config";
import { useHarnessAgent, useHarnessAgents, useHarnessProbe } from "@/core/harness/use-harness";

// Until the user picks one. Every other config default is declared by the
// harness itself; which harness to start from is the one thing no harness can
// answer, so it is a product decision and lives here. It is a preference, not a
// guarantee — see pickDefaultHarnessAgentId for what happens when it isn't
// installed.
const PREFERRED_HARNESS_AGENT_ID: HarnessAgentId = "claude-code";

// The directory a draft is about, which decides what its harness can offer —
// a project's own settings can remap what a model id resolves to. It matches
// the `project.create` path below on purpose: both resolve server-side to the
// same directory, so the providers shown are the providers the session will
// get. Both become the selected project's path once project selection lands.
const DRAFT_CWD = ".";

/**
 * The draft config lives in the URL, and only what the user explicitly picked
 * is written there. Everything absent follows the selected harness's declared
 * default, which is the same thing "omit the field" means to `session.create`.
 *
 * That is what makes switching harness free of reset logic: navigating with a
 * new `harness` simply drops the other params, so everything falls back to the
 * new harness's defaults. No effect, no state to synchronise, no frame where a
 * dropdown holds a value the new harness doesn't offer.
 *
 * A model is two params (`provider` + `model`) that only mean anything
 * together — modelId alone is only unique within its provider.
 */
type DraftSearch = {
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

// "/draft" is the new-session surface: type a first message, which creates a
// session, sends it as the opening turn, and navigates into the live session.
// Keep the "/draft" path literal — the router plugin requires a string literal
// (autoCodeSplitting breaks otherwise).
export const Route = createFileRoute("/draft")({
  validateSearch: (search: Record<string, unknown>): DraftSearch => ({
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

  const harnessAgents = useHarnessAgents();
  const harnessAgentId =
    search.harness ?? pickDefaultHarnessAgentId(harnessAgents, PREFERRED_HARNESS_AGENT_ID);
  const harnessAgent = useHarnessAgent(harnessAgentId);
  // Undefined until the probe lands. That is not a wait: the model picker just
  // has nothing to offer yet, and submitting meanwhile omits `model` — which is
  // exactly what "the user didn't pick one" already means.
  const probe = useHarnessProbe(harnessAgentId, DRAFT_CWD);
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
      // Bootstrap the session under the server's working-directory project until
      // real project selection lands (project.create dedups by path).
      const project = await orpcQueryUtils.project.create.call({ path: DRAFT_CWD });
      const ref = await orpcQueryUtils.session.create.call({
        projectId: project.id,
        harnessAgentId,
        // Omitted when the harness declares no such dimension, which is how it
        // ends up using its own configured default.
        ...(model !== undefined ? { providerId: model.providerId, modelId: model.modelId } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      });
      void manager.attach(ref).prompt(text);
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
      ...createChatBaseExtensions({
        placeholder: () => `Ask ${harnessAgent?.name ?? "your agent"} anything...`,
      }),
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
            {/* Harness first: it decides what the other two can offer. */}
            <PromptInputTools>
              <HarnessSelect
                value={harnessAgentId}
                onChange={(next) => void navigate({ to: "/draft", search: { harness: next } })}
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
            <PromptInputSubmit disabled={!hasContent || startSession.isPending} />
          </PromptInputToolbar>
        </ChatInputProvider>
      </PromptInput>
    </div>
  );
}
