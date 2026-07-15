import { asyncIteratorObject, oc } from "@orpc/contract";
import { z } from "zod";

export const BackendStatusSchema = z.enum(["starting", "ready", "reconnecting", "failed"]);
export type BackendStatus = z.infer<typeof BackendStatusSchema>;

export const BackendStatusSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  status: BackendStatusSchema,
});
export type BackendStatusSnapshot = z.infer<typeof BackendStatusSnapshotSchema>;

export const BackendConnectionSchema = z.object({
  httpBaseUrl: z.string(),
  wsBaseUrl: z.string(),
  token: z.string().min(1),
});
export type BackendConnection = z.infer<typeof BackendConnectionSchema>;

export const DesktopBootstrapSchema = z.object({
  os: z.string(),
  backend: BackendConnectionSchema,
  status: BackendStatusSchema,
  statusRevision: z.number().int().nonnegative(),
});
export type DesktopBootstrap = z.infer<typeof DesktopBootstrapSchema>;

export const desktopContract = {
  bootstrap: oc.output(DesktopBootstrapSchema),
  status: {
    subscribe: oc
      .input(z.object({ after: z.number().int().nonnegative() }))
      .output(asyncIteratorObject(BackendStatusSnapshotSchema)),
  },
  backend: {
    retry: oc.output(z.void()),
  },
  app: {
    quit: oc.output(z.void()),
  },
};

export type DesktopContract = typeof desktopContract;
