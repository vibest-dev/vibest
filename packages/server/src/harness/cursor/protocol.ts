import type { ReasoningEffort } from "@vibest/contract";
import { Schema } from "effect";

// ACP JSON-RPC 2.0 frames over `cursor-agent acp`. Types are local: the ACP
// TypeScript SDK would spawn with `node:child_process`. Treat unknown
// `sessionUpdate` values as skippable — the wire is non-exhaustive across
// cursor-agent releases.

const RpcErrorBody = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
});

export const RpcFrame = Schema.Union([
  Schema.Struct({ id: Schema.Number, result: Schema.Unknown }),
  Schema.Struct({ id: Schema.Number, error: RpcErrorBody }),
  Schema.Struct({
    method: Schema.String,
    id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    params: Schema.optionalKey(Schema.Unknown),
  }),
]);

export const isRpcFrame = Schema.is(RpcFrame);

export type RpcNotification = {
  readonly method: string;
  readonly params?: unknown;
};

export type RpcServerRequest = {
  readonly method: string;
  readonly id: string | number;
  readonly params?: unknown;
};

export type AcpContent = {
  readonly type: string;
  readonly text?: string;
};

export type AcpSessionUpdate = {
  readonly sessionUpdate: string;
  readonly content?: AcpContent;
  readonly toolCallId?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly _meta?: unknown;
};

export type SessionUpdateNotification = {
  readonly method: "session/update";
  readonly params: {
    readonly sessionId: string;
    readonly update: AcpSessionUpdate;
  };
};

export type PermissionOption = {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: string;
};

export type RequestPermissionParams = {
  readonly sessionId: string;
  readonly toolCall?: {
    readonly toolCallId?: string;
    readonly title?: string;
    readonly kind?: string;
    readonly rawInput?: unknown;
    readonly _meta?: unknown;
  };
  readonly options?: ReadonlyArray<PermissionOption>;
};

export type ModelInfoNative = {
  readonly modelId: string;
  readonly name?: string;
  readonly reasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  readonly defaultReasoningEffort?: ReasoningEffort;
};

export type ModelsListResult = {
  readonly availableModels?: ReadonlyArray<ModelInfoNative>;
};

export const CLIENT_INFO = { name: "vibest", title: "Vibest", version: "0.0.0" } as const;
export const AUTH_METHOD_ID = "cursor_login" as const;

export const initializeParams = {
  protocolVersion: 1,
  clientInfo: CLIENT_INFO,
  clientCapabilities: {
    _meta: { parameterizedModelPicker: true },
  },
} as const;

export function isSessionUpdate(
  notification: RpcNotification,
): notification is SessionUpdateNotification {
  return notification.method === "session/update" && notification.params !== undefined;
}

export function isRequestPermission(
  request: RpcServerRequest,
): request is RpcServerRequest & { readonly params: RequestPermissionParams } {
  return request.method === "session/request_permission";
}

export function toolNameOf(update: {
  readonly title?: string;
  readonly kind?: string;
  readonly _meta?: unknown;
}): string {
  if (typeof update.title === "string" && update.title.length > 0) return update.title;
  const meta = update["_meta"];
  if (typeof meta === "object" && meta !== null) {
    const name = (meta as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  if (typeof update.kind === "string" && update.kind.length > 0) return update.kind;
  return "tool";
}

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const asReasoningEffort = (value: string | undefined): ReasoningEffort | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "extra-high" || normalized === "extra high") return "xhigh";
  return REASONING_EFFORTS.has(normalized as ReasoningEffort)
    ? (normalized as ReasoningEffort)
    : undefined;
};

const ConfigOptionSchema = Schema.Struct({
  id: Schema.String,
  currentValue: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(
    Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.optionalKey(Schema.String) })),
  ),
});

const effortFromConfig = (
  options: unknown,
): Pick<ModelInfoNative, "reasoningEfforts" | "defaultReasoningEffort"> => {
  if (!Array.isArray(options)) return {};
  for (const entry of options) {
    try {
      const option = Schema.decodeUnknownSync(ConfigOptionSchema)(entry);
      if (option.id.trim().toLowerCase() !== "effort") continue;
      const reasoningEfforts = (option.options ?? [])
        .map((item) => asReasoningEffort(item.value))
        .filter((value): value is ReasoningEffort => value !== undefined);
      const defaultReasoningEffort = asReasoningEffort(option.currentValue);
      return {
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
        ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
      };
    } catch {
      // Skip a malformed option rather than dropping the model.
    }
  }
  return {};
};

const ModelsListResultSchema = Schema.Struct({
  models: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        value: Schema.String,
        name: Schema.optionalKey(Schema.String),
        configOptions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    ),
  ),
});

export const unwrapModels = (value: unknown): ModelsListResult => {
  try {
    const parsed = Schema.decodeUnknownSync(ModelsListResultSchema)(value);
    return {
      availableModels: (parsed.models ?? []).map((model) => ({
        modelId: model.value,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...effortFromConfig(model.configOptions),
      })),
    };
  } catch {
    return {};
  }
};

const OpenedSessionSchema = Schema.Struct({ sessionId: Schema.NonEmptyString });

export const sessionIdOf = (value: unknown): string | undefined => {
  try {
    return Schema.decodeUnknownSync(OpenedSessionSchema)(value).sessionId;
  } catch {
    return undefined;
  }
};

const InitializeResultSchema = Schema.Struct({
  authMethods: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
});

export const hasCursorLogin = (value: unknown): boolean => {
  try {
    return (Schema.decodeUnknownSync(InitializeResultSchema)(value).authMethods ?? []).some(
      (method) => method.id === AUTH_METHOD_ID,
    );
  } catch {
    return false;
  }
};

const PromptResultSchema = Schema.Struct({ stopReason: Schema.optionalKey(Schema.String) });

export const promptResultOf = (value: unknown): { readonly stopReason?: string } => {
  try {
    return Schema.decodeUnknownSync(PromptResultSchema)(value);
  } catch {
    return {};
  }
};

export const isCancelledStopReason = (stopReason: string | undefined): boolean =>
  stopReason === "cancelled" || stopReason === "canceled";

/** Injected by the agent after `session/prompt` returns, onto the same
 * notification queue as `session/update`, so finish cannot overtake deltas. */
export const TURN_END_METHOD = "vibest/turn_end" as const;

export function isTurnEnd(notification: RpcNotification): boolean {
  return notification.method === TURN_END_METHOD;
}
