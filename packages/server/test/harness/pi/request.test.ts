import { describe, expect, it } from "vitest";

import type { PiUiRequest } from "../../../src/harness/pi/protocol";
import { buildUiRequest, declineUiResponse, mapUiResponse } from "../../../src/harness/pi/request";

const confirm: PiUiRequest = {
  type: "extension_ui_request",
  id: "u1",
  method: "confirm",
  title: "Run tool?",
  message: "About to run rm",
};

const select: PiUiRequest = {
  type: "extension_ui_request",
  id: "u2",
  method: "select",
  title: "Pick one",
  options: ["a", "b"],
};

const input: PiUiRequest = {
  type: "extension_ui_request",
  id: "u3",
  method: "input",
  title: "Name?",
};

const answer = (questionId: string, values: string[], other?: string) =>
  ({ type: "question", answers: [{ questionId, values, ...(other ? { other } : {}) }] }) as const;

describe("pi request mapping", () => {
  it("builds a question AgentRequest carrying the native wire request", () => {
    const request = buildUiRequest(confirm);
    expect(request).toMatchObject({
      type: "question",
      harnessAgentId: "pi",
      id: "u1",
      native: confirm,
    });
    expect(request.questions[0]).toMatchObject({
      question: "About to run rm",
      header: "Run tool?",
      kind: "choice",
    });
    expect(request.questions[0]!.options?.map((o) => o.label)).toEqual(["Yes", "No"]);

    expect(buildUiRequest(select).questions[0]).toMatchObject({
      question: "Pick one",
      options: [{ label: "a" }, { label: "b" }],
    });
    expect(buildUiRequest(input).questions[0]).toMatchObject({ kind: "freeText" });
  });

  it("maps confirm round-trips", () => {
    expect(mapUiResponse(confirm, answer("u1", ["Yes"]))).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: true,
    });
    expect(mapUiResponse(confirm, answer("u1", ["No"]))).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: false,
    });
  });

  it("maps select and free-text round-trips", () => {
    expect(mapUiResponse(select, answer("u2", ["b"]))).toEqual({
      type: "extension_ui_response",
      id: "u2",
      value: "b",
    });
    expect(mapUiResponse(input, answer("u3", [], "Din"))).toEqual({
      type: "extension_ui_response",
      id: "u3",
      value: "Din",
    });
  });

  it("declines when the response carries no usable answer", () => {
    expect(mapUiResponse(select, { type: "question", answers: [] })).toEqual({
      type: "extension_ui_response",
      id: "u2",
      cancelled: true,
    });
    expect(mapUiResponse(confirm, { type: "tool", behavior: "allow" })).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: false,
    });
    expect(declineUiResponse(confirm)).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: false,
    });
    expect(declineUiResponse(input)).toEqual({
      type: "extension_ui_response",
      id: "u3",
      cancelled: true,
    });
  });
});
