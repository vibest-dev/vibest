import { Schema } from "effect";

import { causeSummary } from "../errors";

export class PiTransportError extends Schema.TaggedErrorClass<PiTransportError>()(
  "Pi.TransportError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Pi transport operation '${this.operation}' failed: ${causeSummary(this.cause)}`;
  }
}

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("Pi.RpcError", {
  command: Schema.String,
  errorMessage: Schema.String,
}) {
  override get message() {
    return `Pi RPC command '${this.command}' failed: ${this.errorMessage}`;
  }
}
