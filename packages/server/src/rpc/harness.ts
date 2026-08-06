import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { harnessContract } from "@vibest/contract/harness";
import { Effect } from "effect";

import { HarnessListService, HarnessModelsService } from "../harness";
import type { RpcContext } from "./context";

const orpc = implement(harnessContract).$context<RpcContext>();

export const harnessRouter = orpc.router({
  // Declared data: every registered harness's descriptor, availability and
  // permission subset. A PATH lookup each and nothing more, so the client can
  // await it before first paint.
  list: orpc.list.effect(function* () {
    const list = yield* HarnessListService;
    return yield* list.list;
  }),
  // Fetched data, per directory: costs a CLI spawn, so caching, in-flight
  // de-duplication and the timeout all live in the service — this route is just
  // the wire. A failed read fails the call; collapsing it into an empty result
  // would cache "no models" over what is actually "login expired". The two
  // failures map apart on purpose: an uninstalled harness is UNSUPPORTED
  // (settled — the client greys it out, as `list` already told it to), a CLI
  // that broke while answering is INTERNAL (retryable). Left unmapped, both
  // surfaced as an unhandled internal error and this endpoint became the
  // loudest symptom of a harness that simply was not installed.
  models: orpc.models.effect(function* ({ input, errors }) {
    const models = yield* HarnessModelsService;
    return yield* models.list(input).pipe(
      Effect.catchTags({
        HarnessAgentNotFound: (e) => Effect.fail(errors.UNSUPPORTED({ message: e.message })),
        AgentUnavailable: (e) =>
          Effect.fail(errors.UNSUPPORTED({ message: `${e.harnessAgentId}: ${e.reason}` })),
        ModelListFailed: (e) => Effect.fail(errors.INTERNAL({ message: e.message })),
      }),
    );
  }),
});

export type HarnessRouter = typeof harnessRouter;
