import { describe, expect, it } from "vitest";

import { describeModelError } from "./model-error";

describe("describeModelError", () => {
  it("turns a provider rate-limit response into a readable title and body", () => {
    expect(
      describeModelError(
        '429: {"code":"1308","message":"已达到 5 小时的使用上限。您的限额将在 2026-08-28 00:08:44 重置。"}',
      ),
    ).toEqual({
      title: "Model usage limit reached",
      message: "已达到 5 小时的使用上限。您的限额将在 2026-08-28 00:08:44 重置。",
    });
  });

  it("keeps an unstructured error readable", () => {
    expect(describeModelError("Connection lost while contacting the model")).toEqual({
      title: "Model request failed",
      message: "Connection lost while contacting the model",
    });
  });

  it("keeps a non-429 HTTP status as a generic failure", () => {
    expect(describeModelError('500: {"message":"upstream timeout"}')).toEqual({
      title: "Model request failed",
      message: "upstream timeout",
    });
  });

  it("keeps a plain-text HTTP body when it is not JSON", () => {
    expect(describeModelError("429: rate limited, try again later")).toEqual({
      title: "Model usage limit reached",
      message: "rate limited, try again later",
    });
  });
});
