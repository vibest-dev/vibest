import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

export const TerminalInfoSchema = z.object({
  id: z.string(),
  worktreeId: z.string(),
});

export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

// Terminal event types for streaming
export const TerminalDataEventSchema = z.object({
  type: z.literal("data"),
  data: z.string(),
});

export const TerminalExitEventSchema = z.object({
  type: z.literal("exit"),
  exitCode: z.number(),
});

export const TerminalEventSchema = z.discriminatedUnion("type", [
  TerminalDataEventSchema,
  TerminalExitEventSchema,
]);

export type TerminalEvent = z.infer<typeof TerminalEventSchema>;

export const TerminalModesSchema = z.object({
  applicationCursorKeys: z.boolean(),
  bracketedPaste: z.boolean(),
  mouseTrackingX10: z.boolean(),
  mouseTrackingNormal: z.boolean(),
  mouseTrackingHighlight: z.boolean(),
  mouseTrackingButtonEvent: z.boolean(),
  mouseTrackingAnyEvent: z.boolean(),
  focusReporting: z.boolean(),
  mouseUtf8: z.boolean(),
  mouseSgr: z.boolean(),
  alternateScreen: z.boolean(),
  cursorVisible: z.boolean(),
  originMode: z.boolean(),
  autoWrap: z.boolean(),
});

export const TerminalSnapshotSchema = z.object({
  snapshotAnsi: z.string(),
  rehydrateSequences: z.string(),
  cwd: z.string().nullable(),
  modes: TerminalModesSchema,
  cols: z.number(),
  rows: z.number(),
  scrollbackLines: z.number(),
});

export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;

export const terminalContract = {
  create: oc
    .input(
      z.object({
        worktreeId: z.string(),
        cwd: z.string(),
      }),
    )
    .output(TerminalInfoSchema),

  list: oc
    .input(
      z.object({
        worktreeId: z.string(),
      }),
    )
    .output(z.array(TerminalInfoSchema)),

  write: oc.input(
    z.object({
      terminalId: z.string(),
      data: z.string(),
    }),
  ),

  resize: oc.input(
    z.object({
      terminalId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }),
  ),

  close: oc.input(
    z.object({
      terminalId: z.string(),
    }),
  ),

  snapshot: oc
    .input(
      z.object({
        terminalId: z.string(),
      }),
    )
    .output(TerminalSnapshotSchema.nullable()),

  // Subscribe to terminal output stream
  subscribe: oc
    .input(
      z.object({
        terminalId: z.string(),
      }),
    )
    .output(eventIterator(TerminalEventSchema)),
};
