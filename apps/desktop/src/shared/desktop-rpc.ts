import { asyncIteratorObject, oc } from "@orpc/contract";
import { z } from "zod";

export const ServerStatusSchema = z.enum(["starting", "ready", "reconnecting", "failed"]);
export type ServerStatus = z.infer<typeof ServerStatusSchema>;

export const ServerStatusSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  status: ServerStatusSchema,
});
export type ServerStatusSnapshot = z.infer<typeof ServerStatusSnapshotSchema>;

export const ServerConnectionSchema = z.object({
  httpBaseUrl: z.string(),
  wsBaseUrl: z.string(),
  token: z.string().min(1),
});
export type ServerConnection = z.infer<typeof ServerConnectionSchema>;

/** The three desktop targets, normalized off `process.platform`. */
export const DesktopOsSchema = z.enum(["macos", "windows", "linux"]);
export type DesktopOs = z.infer<typeof DesktopOsSchema>;

export const DesktopBootstrapSchema = z.object({
  status: ServerStatusSchema,
  statusRevision: z.number().int().nonnegative(),
  os: DesktopOsSchema,
});
export type DesktopBootstrap = z.infer<typeof DesktopBootstrapSchema>;

export const desktopContract = {
  bootstrap: oc.output(DesktopBootstrapSchema),
  status: {
    subscribe: oc
      .input(z.object({ after: z.number().int().nonnegative() }))
      .output(asyncIteratorObject(ServerStatusSnapshotSchema)),
  },
  server: {
    connection: oc.output(ServerConnectionSchema),
    retry: oc.output(z.void()),
  },
  app: {
    quit: oc.output(z.void()),
  },
};

export type DesktopContract = typeof desktopContract;
