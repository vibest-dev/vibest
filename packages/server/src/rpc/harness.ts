import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { harnessContract } from "@vibest/contract/harness";

import { HarnessAgentCatalogService, HarnessNegotiationService } from "../harness";
import type { RpcContext } from "./context";

const orpc = implement(harnessContract).$context<RpcContext>();

export const harnessRouter = orpc.router({
  // Static: every registered harness's descriptor, availability and permission
  // vocabulary. A PATH lookup each and nothing more, so the client can await it
  // before first paint.
  negotiate: orpc.negotiate.effect(function* () {
    const negotiation = yield* HarnessNegotiationService;
    return yield* negotiation.negotiate;
  }),
  // Runtime, per directory: costs a CLI spawn, so caching, in-flight
  // de-duplication and the timeout all live in the service — this route is just
  // the wire.
  catalog: orpc.catalog.effect(function* ({ input }) {
    const catalog = yield* HarnessAgentCatalogService;
    return yield* catalog.get(input);
  }),
});

export type HarnessRouter = typeof harnessRouter;
