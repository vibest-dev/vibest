import { oc } from "@orpc/contract";
import { Schema } from "effect";

import {
  HarnessGetDefaultModelInputSchema,
  HarnessGetDefaultModelOutputSchema,
  HarnessListModelsInputSchema,
  HarnessListModelsOutputSchema,
  HarnessListOutputSchema,
  toStandardSchema,
} from "./domain";

// Harness discovery, model catalog, and default-model resolution stay separate:
// callers should never infer the latter from list order or catalog metadata.
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
   * What one harness's model providers offer. A live `sessionId` routes the
   * query through that session's existing runtime; otherwise the server runs a
   * short-lived directory query. The latter is cached because it can require a
   * CLI spawn and varies by working directory.
   *
   * A failed query fails the call — it is never collapsed into an empty
   * result. An expired login answering "no models" would otherwise look like
   * "this harness has no model picker", the worst kind of silent error.
   */
  listModels: oc
    .input(toStandardSchema(HarnessListModelsInputSchema))
    .output(toStandardSchema(HarnessListModelsOutputSchema)),
  /**
   * The concrete provider/model pair a fresh session would use in this
   * directory. Kept separate from listModels: the catalog describes choices;
   * this query asks the harness to run its own default/fallback resolution.
   */
  getDefaultModel: oc
    .input(toStandardSchema(HarnessGetDefaultModelInputSchema))
    .output(toStandardSchema(HarnessGetDefaultModelOutputSchema)),
};
