export type ModelErrorDetails = {
  title: string;
  message: string;
};

const HTTP_ERROR_PATTERN = /^(\d{3}):\s*([\s\S]+)$/;

/** Provider failures arrive as `NNN: body`. Pull a readable title and message out. */
export function describeModelError(rawMessage: string): ModelErrorDetails {
  const match = HTTP_ERROR_PATTERN.exec(rawMessage.trim());
  if (!match) return { title: "Model request failed", message: rawMessage };

  const httpStatus = Number(match[1]);
  const body = match[2] ?? rawMessage;
  let message = body;

  try {
    const payload: unknown = JSON.parse(body);
    if (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      message = payload.message;
    }
  } catch {
    // Some providers return plain text after the HTTP status.
  }

  return {
    title: httpStatus === 429 ? "Model usage limit reached" : "Model request failed",
    message,
  };
}
