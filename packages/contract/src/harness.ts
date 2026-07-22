import { oc } from "@orpc/contract";
import { Schema } from "effect";

import {
  HarnessAgentCatalogInputSchema,
  HarnessAgentCatalogSchema,
  HarnessNegotiationSchema,
  toStandardSchema,
} from "./domain";

// Harness-level negotiation, run once after the client connects — the MCP
// `initialize` analogue for a vibest server that hosts many harnesses. A single
// call returns every harness's availability + capabilities; the client holds
// the result and reads per-harness data by id, rather than pulling capabilities
// per harness or re-negotiating when the user switches harness.
//
// It is deliberately static — a PATH lookup per harness and nothing else — so
// it stays sub-millisecond and the client can keep awaiting it before first
// paint. Anything that needs a CLI to answer belongs to `catalog`.
export const harnessContract = {
  negotiate: oc
    .input(toStandardSchema(Schema.Struct({})))
    .output(toStandardSchema(HarnessNegotiationSchema)),
  /**
   * What one harness offers in one working directory. Split from negotiate on
   * two counts: the answer changes per directory, and obtaining it spawns a
   * CLI — so it is fetched lazily, for the selected harness only, off the
   * startup path.
   */
  catalog: oc
    .input(toStandardSchema(HarnessAgentCatalogInputSchema))
    .output(toStandardSchema(HarnessAgentCatalogSchema)),
};
