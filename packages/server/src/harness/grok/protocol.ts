import { Schema } from "effect";

// ACP JSON-RPC 2.0 frames over `grok agent --no-leader stdio`, plus the
// Grok `_x.ai/*` extensions we actually consume. Types are local: the ACP
// TypeScript SDK would spawn with `node:child_process`, and Grok's x.ai
// methods are not in the base schema. Treat unknown `sessionUpdate` values as
// skippable — the wire is non-exhaustive across grok releases.

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

export type XaiSessionNotification = {
  readonly method: "_x.ai/session/update" | "_x.ai/session_notification";
  readonly params: {
    readonly sessionId: string;
    readonly update: {
      readonly sessionUpdate: string;
      readonly stop_reason?: string;
      readonly prompt_id?: string;
      readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly cachedReadTokens?: number;
        readonly cacheCreationTokens?: number;
      };
    };
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
  readonly description?: string;
  readonly _meta?: {
    readonly supportsReasoningEffort?: boolean;
    readonly reasoningEffort?: string;
    readonly reasoningEfforts?: ReadonlyArray<{
      readonly id?: string;
      readonly value?: string;
      readonly label?: string;
      readonly default?: boolean;
    }>;
  };
};

export type ModelsListResult = {
  readonly currentModelId?: string;
  readonly availableModels?: ReadonlyArray<ModelInfoNative>;
};

export const CLIENT_INFO = { name: "vibest", title: "Vibest", version: "0.0.0" } as const;

export function isSessionUpdate(
  notification: RpcNotification,
): notification is SessionUpdateNotification {
  return notification.method === "session/update" && notification.params !== undefined;
}

export function isXaiSessionNotification(
  notification: RpcNotification,
): notification is XaiSessionNotification {
  return (
    (notification.method === "_x.ai/session/update" ||
      notification.method === "_x.ai/session_notification") &&
    notification.params !== undefined
  );
}

export function isRequestPermission(
  request: RpcServerRequest,
): request is RpcServerRequest & { readonly params: RequestPermissionParams } {
  return request.method === "session/request_permission";
}

export function toolNameOf(meta: unknown, title?: string): string {
  if (typeof meta === "object" && meta !== null) {
    const tool = (meta as { "x.ai/tool"?: { name?: unknown } })["x.ai/tool"];
    if (typeof tool?.name === "string" && tool.name.length > 0) return tool.name;
  }
  if (typeof title === "string" && title.length > 0) return title;
  return "tool";
}

export const ModelsListResultSchema = Schema.Struct({
  currentModelId: Schema.optionalKey(Schema.String),
  availableModels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        modelId: Schema.String,
        name: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});

export const unwrapModels = (value: unknown): ModelsListResult => {
  try {
    return Schema.decodeUnknownSync(ModelsListResultSchema)(value);
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
