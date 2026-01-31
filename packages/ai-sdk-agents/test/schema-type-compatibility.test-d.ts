import type * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod/v4";

import { describe, expectTypeOf, test } from "vitest";

import type {
  McpServerStatusSchema,
  ModelInfoSchema,
  PermissionBehaviorSchema,
  PermissionModeSchema,
  PermissionResultSchema,
  SlashCommandSchema,
} from "../src/claude-code/schema";

type SlashCommand = z.infer<typeof SlashCommandSchema>;
type ModelInfo = z.infer<typeof ModelInfoSchema>;
type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
type PermissionMode = z.infer<typeof PermissionModeSchema>;
type PermissionBehavior = z.infer<typeof PermissionBehaviorSchema>;
type PermissionResult = z.infer<typeof PermissionResultSchema>;

describe("Schema Type Compatibility", () => {
  describe("Bidirectional Type Equality", () => {
    test("SlashCommand schema matches SDK type", () => {
      expectTypeOf<SlashCommand>().toEqualTypeOf<sdk.SlashCommand>();
      expectTypeOf<sdk.SlashCommand>().toEqualTypeOf<SlashCommand>();
    });

    test("ModelInfo schema matches SDK type", () => {
      expectTypeOf<ModelInfo>().toEqualTypeOf<sdk.ModelInfo>();
      expectTypeOf<sdk.ModelInfo>().toEqualTypeOf<ModelInfo>();
    });

    test("McpServerStatus schema matches SDK type", () => {
      expectTypeOf<McpServerStatus>().toEqualTypeOf<sdk.McpServerStatus>();
      expectTypeOf<sdk.McpServerStatus>().toEqualTypeOf<McpServerStatus>();
    });

    test("PermissionMode schema matches SDK type", () => {
      expectTypeOf<PermissionMode>().toEqualTypeOf<sdk.PermissionMode>();
      expectTypeOf<sdk.PermissionMode>().toEqualTypeOf<PermissionMode>();
    });

    test("PermissionBehavior schema matches SDK type", () => {
      expectTypeOf<PermissionBehavior>().toEqualTypeOf<sdk.PermissionBehavior>();
      expectTypeOf<sdk.PermissionBehavior>().toEqualTypeOf<PermissionBehavior>();
    });

    test("PermissionResult schema matches SDK type", () => {
      expectTypeOf<PermissionResult>().toEqualTypeOf<sdk.PermissionResult>();
      expectTypeOf<sdk.PermissionResult>().toEqualTypeOf<PermissionResult>();
    });
  });

  describe("PermissionResult Discriminated Union", () => {
    type AllowResult = Extract<PermissionResult, { behavior: "allow" }>;
    type SDKAllowResult = Extract<sdk.PermissionResult, { behavior: "allow" }>;
    type DenyResult = Extract<PermissionResult, { behavior: "deny" }>;
    type SDKDenyResult = Extract<sdk.PermissionResult, { behavior: "deny" }>;

    describe("Union Branches", () => {
      test("allow branch matches SDK", () => {
        expectTypeOf<AllowResult>().toEqualTypeOf<SDKAllowResult>();
        expectTypeOf<SDKAllowResult>().toEqualTypeOf<AllowResult>();
      });

      test("deny branch matches SDK", () => {
        expectTypeOf<DenyResult>().toEqualTypeOf<SDKDenyResult>();
        expectTypeOf<SDKDenyResult>().toEqualTypeOf<DenyResult>();
      });
    });

    describe("Allow Branch Properties", () => {
      test("behavior is literal 'allow'", () => {
        expectTypeOf<AllowResult["behavior"]>().toEqualTypeOf<"allow">();
      });

      test("updatedInput is Record<string, unknown>", () => {
        expectTypeOf<AllowResult["updatedInput"]>().toEqualTypeOf<Record<string, unknown>>();
      });

      test("updatedPermissions is optional array", () => {
        expectTypeOf<AllowResult["updatedPermissions"]>().toEqualTypeOf<
          sdk.PermissionUpdate[] | undefined
        >();
      });
    });

    describe("Deny Branch Properties", () => {
      test("behavior is literal 'deny'", () => {
        expectTypeOf<DenyResult["behavior"]>().toEqualTypeOf<"deny">();
      });

      test("message is string", () => {
        expectTypeOf<DenyResult["message"]>().toEqualTypeOf<string>();
      });

      test("interrupt is optional boolean", () => {
        expectTypeOf<DenyResult["interrupt"]>().toEqualTypeOf<boolean | undefined>();
      });
    });

    describe("Union Exhaustiveness", () => {
      type AllPermissionResultCases = AllowResult | DenyResult;

      test("union covers all cases", () => {
        expectTypeOf<PermissionResult>().toEqualTypeOf<AllPermissionResultCases>();
      });

      test("no extra cases exist", () => {
        expectTypeOf<AllPermissionResultCases>().toEqualTypeOf<PermissionResult>();
      });
    });
  });

  describe("Enum Values", () => {
    test("PermissionMode has correct values", () => {
      expectTypeOf<PermissionMode>().toEqualTypeOf<
        "default" | "acceptEdits" | "bypassPermissions" | "plan" | "delegate" | "dontAsk"
      >();
    });

    test("PermissionBehavior has correct values", () => {
      expectTypeOf<PermissionBehavior>().toEqualTypeOf<"allow" | "deny" | "ask">();
    });

    test("McpServerStatus status has correct values", () => {
      expectTypeOf<McpServerStatus["status"]>().toEqualTypeOf<
        "connected" | "failed" | "needs-auth" | "pending"
      >();
    });
  });

  describe("Structural Validation", () => {
    describe("SlashCommand", () => {
      test("has name property", () => {
        expectTypeOf<SlashCommand>().toHaveProperty("name");
      });

      test("has description property", () => {
        expectTypeOf<SlashCommand>().toHaveProperty("description");
      });

      test("has argumentHint property", () => {
        expectTypeOf<SlashCommand>().toHaveProperty("argumentHint");
      });
    });

    describe("ModelInfo", () => {
      test("has value property", () => {
        expectTypeOf<ModelInfo>().toHaveProperty("value");
      });

      test("has displayName property", () => {
        expectTypeOf<ModelInfo>().toHaveProperty("displayName");
      });

      test("has description property", () => {
        expectTypeOf<ModelInfo>().toHaveProperty("description");
      });
    });

    describe("McpServerStatus", () => {
      test("has name property", () => {
        expectTypeOf<McpServerStatus>().toHaveProperty("name");
      });

      test("has status property", () => {
        expectTypeOf<McpServerStatus>().toHaveProperty("status");
      });

      test("has serverInfo property", () => {
        expectTypeOf<McpServerStatus>().toHaveProperty("serverInfo");
      });
    });
  });
});
