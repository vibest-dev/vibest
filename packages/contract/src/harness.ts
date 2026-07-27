import { oc } from "@orpc/contract";
import { Schema } from "effect";

import {
  HarnessListOutputSchema,
  HarnessProbeInputSchema,
  HarnessProbeOutputSchema,
  toStandardSchema,
} from "./domain";

// The two harness data endpoints, split by what answering costs — not by what
// the answer means (both can carry normalized and opaque settings, see
// docs/design/harness-concept-ownership.md §5).
export const harnessContract = {
  /**
   * Every harness the server hosts: descriptor, availability, and the
   * normalized settings it declares (permission modes). A PATH lookup per
   * harness and nothing else — cheap enough to await before first paint, and
   * it cannot fail.
   */
  list: oc
    .input(toStandardSchema(Schema.Struct({})))
    .output(toStandardSchema(HarnessListOutputSchema)),
  /**
   * What one harness's model providers offer in one working directory. Costs a
   * CLI spawn and the answer changes per directory, so it is fetched lazily,
   * for the selected harness only, off the startup path.
   *
   * A failed probe fails the call — it is never collapsed into an empty
   * result. An expired login answering "no models" would be cached as "this
   * harness has no model picker", which is the worst kind of silent error; the
   * client renders a retryable degraded state instead.
   */
  probe: oc
    .input(toStandardSchema(HarnessProbeInputSchema))
    .output(toStandardSchema(HarnessProbeOutputSchema)),
};
