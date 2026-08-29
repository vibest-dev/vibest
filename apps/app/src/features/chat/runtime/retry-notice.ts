import type { UIMessageChunk } from "ai";

function retryField(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null || !(key in data)) return undefined;
  return Reflect.get(data, key);
}

/** Transient Pi retry copy. Not an Error — the turn is still open. */
export function retryNoticeFrom(chunk: UIMessageChunk): string | undefined {
  if (chunk.type !== "data-retry") return undefined;
  const data = "data" in chunk ? chunk.data : undefined;
  const errorMessage = retryField(data, "errorMessage");
  const reason =
    errorMessage === "Connection error."
      ? "Couldn't reach the model provider"
      : typeof errorMessage === "string"
        ? errorMessage
        : "";
  const attempt = retryField(data, "attempt");
  const maxAttempts = retryField(data, "maxAttempts");
  const suffix =
    typeof attempt === "number" && typeof maxAttempts === "number"
      ? `Retrying (${attempt}/${maxAttempts})…`
      : "Retrying…";
  return reason ? `${reason}. ${suffix}` : suffix;
}
