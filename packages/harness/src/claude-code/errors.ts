import { Schema } from "effect";

export class ClaudeSdkError extends Schema.TaggedErrorClass<ClaudeSdkError>()("ClaudeSdkError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Claude SDK operation '${this.operation}' failed.`;
  }
}
