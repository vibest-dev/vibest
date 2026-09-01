import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { SessionRecoverySnapshot } from "@vibest/contract";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputToolbar,
  PromptInputTools,
} from "@vibest/ui/ai-elements/prompt-input";
import { Button } from "@vibest/ui/components/button";
import { Card, CardFrame, CardFrameFooter, CardFrameHeader } from "@vibest/ui/components/card";
import { GitBranchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useStore } from "zustand";

import type { OutgoingMessage } from "@/features/chat/runtime/chat-state";

import { useChatSession } from "./chat-session-context";
import { ChatInput } from "./input/chat-input";
import { ChatInputProvider } from "./input/chat-input-provider";
import { createChatBaseExtensions } from "./input/extensions/chat-base-extensions";
import { createSubmitKeymap } from "./input/extensions/keymaps";
import { useChatInputController } from "./input/use-chat-input-controller";
import { useChatInputHasContent } from "./input/use-chat-input-has-content";

const recoveryPromptSummary = (prompt: SessionRecoverySnapshot["prompts"][number]): string => {
  const text: string[] = [];
  let fileSummary: string | undefined;
  let targets = 0;
  for (const part of prompt.parts) {
    switch (part.type) {
      case "text":
        text.push(part.text);
        break;
      case "file":
        fileSummary ??= part.filename ?? part.url;
        break;
      case "data-inspector":
        targets += part.data.length;
        break;
    }
  }
  const joinedText = text.join(" ").trim();
  if (joinedText) return joinedText;
  if (fileSummary) return fileSummary;
  return targets === 1 ? "1 inspector target" : `${targets} inspector targets`;
};

function UncertainPromptList({ prompts }: { prompts: SessionRecoverySnapshot["prompts"] }) {
  return (
    <ol aria-label="Uncertain prompts" className="w-full space-y-2">
      {prompts.map((prompt, index) => {
        const summary = recoveryPromptSummary(prompt);
        return (
          <li
            key={prompt.messageId}
            data-slot="uncertain-user-message"
            className="flex min-w-0 items-center gap-3 text-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={summary}>
              {summary}
            </span>
            <span className="text-muted-foreground shrink-0 text-xs">Uncertain · {index + 1}</span>
          </li>
        );
      })}
    </ol>
  );
}

function QueuedPromptList({
  messages,
  canSteer,
  onSteer,
}: {
  messages: OutgoingMessage[];
  canSteer: boolean;
  onSteer: (messageId: string) => void;
}) {
  let followUpIndex = 0;
  return (
    <ol
      aria-label="Queued prompts"
      aria-live="polite"
      className="max-h-48 w-full scrollbar-thin space-y-2 overflow-y-auto"
    >
      {messages.map((outgoing) => {
        const text = outgoing.message.parts
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        if (outgoing.delivery === "follow-up") followUpIndex += 1;
        const label =
          outgoing.status === "failed"
            ? "Steer failed"
            : outgoing.delivery === "steer"
              ? outgoing.status === "sending"
                ? "Steering…"
                : "Steer"
              : `Follow-up · ${followUpIndex}`;
        return (
          <li
            key={outgoing.message.id}
            data-slot="queued-user-message"
            className="flex min-w-0 items-center gap-3 text-sm"
          >
            <span className="min-w-0 flex-1 truncate" title={text}>
              {text}
            </span>
            {canSteer && outgoing.delivery === "follow-up" && outgoing.status === "queued" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-auto shrink-0 px-1.5 py-0 text-xs"
                onClick={() => onSteer(outgoing.message.id)}
              >
                Steer
              </Button>
            )}
            <span
              className={
                outgoing.status === "failed"
                  ? "text-destructive shrink-0 text-xs"
                  : "text-muted-foreground shrink-0 text-xs"
              }
              title={outgoing.error?.message}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ChatInputComposer({
  cwd,
  toolbar,
}: {
  /** Session workspace path, from the route. Used to probe the current branch. */
  cwd: string | undefined;
  toolbar?: ReactNode;
}) {
  const { orpcQueryUtils } = useRouteContext({ from: "__root__" });
  const branch = useQuery({
    ...orpcQueryUtils.git.branch.queryOptions({ input: { cwd: cwd ?? "" } }),
    enabled: cwd !== undefined,
  });
  const { acknowledgeRecovery, prompt, steer, turnInProgress, store } = useChatSession();
  const status = useStore(store, (state) => state.session.status);
  const activeTurnId = useStore(store, (state) => state.session.activeTurnId);
  const outgoing = useStore(store, (state) => state.outgoing);
  const recovery = useStore(store, (state) => state.recovery.snapshot);
  const [acknowledgementError, setAcknowledgementError] = useState<string | null>(null);

  const controller = useChatInputController({
    extensions: (self) => [
      ...createChatBaseExtensions(),
      createSubmitKeymap({ onSubmit: () => void self.submit() }),
    ],
    onSubmit: (text) => {
      if (recovery !== null) return false;
      // The composer clears once the message is accepted into the local queue;
      // the promise may settle later when this item reaches the server.
      void prompt(text).catch(() => undefined);
      return;
    },
  });

  const hasContent = useChatInputHasContent(controller);
  const canSteer = activeTurnId !== null;

  return (
    <CardFrame>
      {(recovery !== null || outgoing.length > 0) && (
        <CardFrameHeader className="flex-col items-stretch gap-3 p-3">
          {recovery !== null && (
            <div className="flex flex-col gap-2 text-sm" role="status">
              <p>
                The server restarted during a possible active turn. The old work was not replayed.
                Committed history is shown where available.
              </p>
              <UncertainPromptList prompts={recovery.prompts} />
              <Button
                className="self-start"
                size="sm"
                type="button"
                variant="outline"
                onClick={() => {
                  setAcknowledgementError(null);
                  void acknowledgeRecovery(recovery.recoveryId).catch((error: unknown) => {
                    setAcknowledgementError(
                      error instanceof Error ? error.message : "Recovery acknowledgement failed",
                    );
                  });
                }}
              >
                Acknowledge uncertainty and allow future prompts
              </Button>
              {acknowledgementError !== null && (
                <p className="text-destructive" role="alert">
                  {acknowledgementError}
                </p>
              )}
            </div>
          )}
          {outgoing.length > 0 && (
            <QueuedPromptList messages={outgoing} canSteer={canSteer} onSteer={steer} />
          )}
        </CardFrameHeader>
      )}
      <Card
        aria-disabled={recovery !== null}
        inert={recovery !== null ? true : undefined}
        render={
          <PromptInput
            onSubmit={(event) => {
              event.preventDefault();
              void controller?.submit();
            }}
          />
        }
      >
        <ChatInputProvider controller={controller}>
          <ChatInput />
          <PromptInputToolbar>
            <PromptInputTools>{toolbar}</PromptInputTools>
            <PromptInputSubmit
              disabled={!hasContent || recovery !== null}
              // During a turn this button enqueues rather than interrupts, so the
              // send arrow is the truthful affordance instead of the stop square.
              status={turnInProgress ? "ready" : status}
            />
          </PromptInputToolbar>
        </ChatInputProvider>
      </Card>
      {branch.data?.current ? (
        <CardFrameFooter className="py-2">
          <span
            className="text-muted-foreground flex items-center gap-1.5 px-3 text-xs"
            title="Current git branch"
          >
            <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{branch.data.current}</span>
          </span>
        </CardFrameFooter>
      ) : null}
    </CardFrame>
  );
}
