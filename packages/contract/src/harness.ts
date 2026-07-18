import { oc } from "@orpc/contract";

import {
  HarnessAgentCapabilitiesSchema,
  HarnessAgentIdInputSchema,
  toStandardSchema,
} from "./domain";

// Harness-level negotiation, distinct from the per-session routes: a harness's
// capabilities are the same for every session it hosts, so they're addressed by
// harnessAgentId — not by sessionId — and can be fetched before any session
// exists (e.g. to drive the create-time permission-mode picker).
export const harnessContract = {
  capabilities: oc
    .input(toStandardSchema(HarnessAgentIdInputSchema))
    .output(toStandardSchema(HarnessAgentCapabilitiesSchema)),
};
