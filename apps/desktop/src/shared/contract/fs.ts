import { oc } from "@orpc/contract";
import { z } from "zod";

export const fsContract = {
  selectDir: oc.output(z.string()), // Returns empty string if cancelled

  openTerminal: oc.input(
    z.object({
      path: z.string(),
    }),
  ),

  openFinder: oc.input(
    z.object({
      path: z.string(),
    }),
  ),

  openInVSCode: oc.input(
    z.object({
      path: z.string(),
    }),
  ),

  openInCursor: oc.input(
    z.object({
      path: z.string(),
    }),
  ),
};
