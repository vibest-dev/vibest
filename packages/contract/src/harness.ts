import { oc } from "@orpc/contract";
import { Schema } from "effect";

import { HarnessNegotiationSchema, toStandardSchema } from "./domain";

// Harness-level negotiation, run once after the client connects — the MCP
// `initialize` analogue for a vibest server that hosts many harnesses. A single
// call returns every harness's availability + capabilities; the client holds
// the result and reads per-harness data by id, rather than pulling capabilities
// per harness or re-negotiating when the user switches harness.
export const harnessContract = {
  negotiate: oc
    .input(toStandardSchema(Schema.Struct({})))
    .output(toStandardSchema(HarnessNegotiationSchema)),
};
