import { Schema } from "effect";

import { causeSummary } from "../errors";

export class CodexTransportError extends Schema.TaggedErrorClass<CodexTransportError>()(
  "Codex.TransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Codex transport operation '${this.operation}' failed: ${causeSummary(this.cause)}`;
  }
}

export class CodexRpcError extends Schema.TaggedErrorClass<CodexRpcError>()("Codex.RpcError", {
  method: Schema.String,
  code: Schema.Number,
  errorMessage: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
}) {
  override get message() {
    return `Codex RPC '${this.method}' failed (${this.code}): ${this.errorMessage}`;
  }
}
