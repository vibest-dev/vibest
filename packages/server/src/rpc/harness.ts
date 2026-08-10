import "@orpc/experimental-effect/extensions/effect";
import { implement } from "@orpc/server";
import { harnessContract } from "@vibest/contract/harness";

import { HarnessListService, HarnessModelService } from "../harness";
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
  // A live session is queried through its existing runtime. Otherwise the
  // model module performs the cached, short-lived directory query. This route
  // only binds that behavior to the wire.
  listModels: orpc.listModels.effect(function* ({ input }) {
    const models = yield* HarnessModelService;
    return yield* models.listModels(input);
  }),
  getDefaultModel: orpc.getDefaultModel.effect(function* ({ input }) {
    const models = yield* HarnessModelService;
    return yield* models.getDefaultModel(input);
  }),
});

export type HarnessRouter = typeof harnessRouter;
