import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { harnessContract } from "@vibest/contract/harness";

import { HarnessListService, HarnessProbeService } from "../harness";
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
  // Probed data, per directory: costs a CLI spawn, so caching, in-flight
  // de-duplication and the timeout all live in the service — this route is just
  // the wire. A failed probe fails the call; collapsing it into an empty result
  // would cache "no models" over what is actually "login expired".
  probe: orpc.probe.effect(function* ({ input }) {
    const probe = yield* HarnessProbeService;
    return yield* probe.probe(input);
  }),
});

export type HarnessRouter = typeof harnessRouter;
