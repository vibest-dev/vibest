import { oc } from "@orpc/contract";
import { z } from "zod";

export const shellContract = {
  openExternal: oc.input(
    z.object({
      url: z.string(),
    }),
  ),
};
