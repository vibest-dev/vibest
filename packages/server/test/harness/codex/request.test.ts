import type { ServerRequest } from "@vibest/contract/codex/protocol"; // ← verified path
import { describe, expect, it } from "vitest";

import {
  buildApprovalRequest,
  buildUserInputRequest,
  declineResult,
  mapApprovalResponse,
  mapUserInputResponse,
} from "../../../src/harness/codex/request";

const approval = {
  method: "item/commandExecution/requestApproval",
  id: 1,
  params: { threadId: "th", command: "rm -rf /tmp/x", cwd: "/w" },
} as unknown as ServerRequest & { method: "item/commandExecution/requestApproval" };

describe("codex request mapping", () => {
  it("builds a tool AgentRequest from an approval", () => {
    const req = buildApprovalRequest(approval);
    expect(req).toMatchObject({
      type: "tool",
      harnessAgentId: "codex",
      toolName: "commandExecution",
      input: { command: "rm -rf /tmp/x", cwd: "/w" },
    });
    expect(req.actions.map((a) => a.id)).toEqual(["accept", "decline"]);
  });

  it("maps allow/deny to codex decisions", () => {
    expect(mapApprovalResponse({ type: "tool", behavior: "allow" }, "commandExecution")).toEqual({
      decision: "accept",
    });
    expect(mapApprovalResponse({ type: "tool", behavior: "deny" }, "commandExecution")).toEqual({
      decision: "decline",
    });
    expect(declineResult("permissions")).toEqual({ permissions: {}, scope: "turn" });
  });

  it("permissions approvals always answer with an empty turn-scoped grant (v1 limitation)", () => {
    // Same reply for allow and deny: grants can't flow until the richer
    // approval UI carries the grant payload via `native`.
    expect(mapApprovalResponse({ type: "tool", behavior: "allow" }, "permissions")).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(mapApprovalResponse({ type: "tool", behavior: "deny" }, "permissions")).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  it("maps question round-trips", () => {
    const req = buildUserInputRequest({
      method: "item/tool/requestUserInput",
      id: 2,
      params: {
        threadId: "th",
        questions: [{ id: "q1", question: "Which?", options: [{ label: "a" }, { label: "b" }] }],
      },
    } as never);
    expect(req).toMatchObject({ type: "question", harnessAgentId: "codex" });
    expect(
      mapUserInputResponse({
        type: "question",
        answers: [{ questionId: "q1", values: ["a"], other: "note" }],
      }),
    ).toEqual({ answers: { q1: { answers: ["a", "note"] } } });
  });
});
